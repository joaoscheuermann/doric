// OAuth for HTTP MCP servers: a background connect never registers a client
// or opens a browser, sign-in is PKCE with the server as the resource, the
// tokens live only in secrets/v1 as MCP_TOKEN credentials, and they follow
// the server's configuration.

import assert from 'node:assert/strict';
import test from 'node:test';

import { textTool } from './support/mcp-server.js';
import { followRedirect } from './support/oauth-server.js';
import { authorizing, guarded, opened, served } from './support/setup.js';
import { signInThrough, tokenCredentials } from './support/sign-in.js';
import { codeOf, eventually, sleep } from './support/wait.js';
import {
  activateWorld,
  createEnvironment,
  httpServer,
  inState,
  P1,
  serverOf,
} from './support/world.js';

/** Asserts the promise rejects with a contract error of that code. */
const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.equal(codeOf(error), code);
    return true;
  });

void test('A1 a server answering 401 with resource metadata needs sign-in, and no client is registered', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'needs-sign-in'),
    'needs-sign-in',
  );

  assert.equal(serverOf(servers, created.id)?.signedIn, false);

  assert.deepEqual(world.liveNames(P1), []);

  assert.ok(!as.paths.includes('/register'));

  assert.deepEqual(as.registrations, []);
});

void test('A2 signIn answers a PKCE S256 authorization URL for the server resource with a loopback redirect', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));

  const { url } = await world.mcp(P1).signIn({ id: created.id });
  const authorization = new URL(url);
  const redirectUri = authorization.searchParams.get('redirect_uri') ?? '';
  const redirect = new URL(redirectUri);

  assert.equal(
    `${authorization.origin}${authorization.pathname}`,
    `${as.issuer}/authorize`,
  );

  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');

  assert.ok((authorization.searchParams.get('code_challenge') ?? '') !== '');

  assert.ok((authorization.searchParams.get('state') ?? '') !== '');

  assert.equal(authorization.searchParams.get('resource'), server.url);

  assert.equal(redirect.hostname, '127.0.0.1');

  const [registration] = as.registrations;

  assert.equal(registration?.token_endpoint_auth_method, 'none');

  assert.deepEqual(registration?.redirect_uris, [redirectUri]);
});

void test('A3 the browser redirect completes sign-in: connected, tokens kept only as MCP_TOKEN credentials', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));

  const { view } = await signInThrough(world, P1, created.id, as);
  const [tokens] = as.issued;

  assert.equal(view.status.state, 'connected');

  assert.equal(view.signedIn, true);

  assert.ok(tokens !== undefined);

  const stored = tokenCredentials(world, created.id);

  assert.equal(
    stored.find((entry) => entry.name === `mcp:${created.id}:access`)?.secret,
    tokens.accessToken,
  );

  assert.equal(
    stored.find((entry) => entry.name === `mcp:${created.id}:refresh`)?.secret,
    tokens.refreshToken,
  );

  const documents = JSON.stringify(world.env.serverDocuments());

  assert.ok(!documents.includes(tokens.accessToken));

  assert.ok(!documents.includes(tokens.refreshToken));

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);
});

void test('A4 a callback whose iss differs from the advertised issuer fails sign-in and stores no token', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t, { issParameterSupported: true });
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const mcp = world.mcp(P1);

  const { url } = await mcp.signIn({ id: created.id });
  const approval = as.approve(url);
  const finishing = rejectsWith(
    mcp.finishSignIn({ id: created.id }),
    'mcp_signin_failed',
  );
  await followRedirect(approval, { iss: 'http://evil.example' });
  await finishing;

  assert.deepEqual(tokenCredentials(world, created.id), []);

  assert.ok(
    !world.env.secretCalls.created.some((input) => input.kind === 'MCP_TOKEN'),
  );
});

for (const [label, codeChallengeMethods] of [
  ['without code_challenge_methods_supported', null],
  ['supporting only plain', ['plain']],
] as const) {
  void test(`A5 an authorization server ${label} fails signIn`, async (t) => {
    const world = await opened(t);
    const as = await authorizing(t, { codeChallengeMethods });
    const server = await guarded(t, as, { tools: [textTool('alpha')] });
    const created = await world.mcp(P1).create(httpServer('docs', server.url));

    await rejectsWith(
      world.mcp(P1).signIn({ id: created.id }),
      'mcp_signin_failed',
    );
  });
}

void test('A6 a new activation with an expired access token refreshes it and connects without sign-in', async (t) => {
  const env = createEnvironment();
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const first = await activateWorld(env);
  const created = await first.mcp(P1).create(httpServer('docs', server.url));
  await signInThrough(first, P1, created.id, as);
  await first.deactivate();
  const [old] = as.issued;
  assert.ok(old !== undefined);
  as.accessTokens.delete(old.accessToken);

  const world = await opened(t, env);
  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'connected'),
    'connected again',
  );

  assert.equal(serverOf(servers, created.id)?.signedIn, true);

  assert.ok(
    as.tokenRequests.some(
      (request) =>
        request.grant_type === 'refresh_token' &&
        request.refresh_token === old.refreshToken,
    ),
  );

  const refreshed = as.issued.at(-1);

  assert.notEqual(refreshed?.accessToken, old.accessToken);

  assert.equal(
    env.credentialNamed(`mcp:${created.id}:access`)?.secret,
    refreshed?.accessToken,
  );

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);
});

void test('A7 finishSignIn without a pending signIn is refused as not started', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));

  await rejectsWith(
    world.mcp(P1).finishSignIn({ id: created.id }),
    'mcp_signin_not_started',
  );
});

void test('A7 aborting the finishSignIn call rejects it as aborted', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.mcp(P1).signIn({ id: created.id });
  const controller = new AbortController();

  const finishing = rejectsWith(
    world
      .mcp(P1)
      .finishSignIn({ id: created.id }, { signal: controller.signal }),
    'mcp_signin_aborted',
  );
  await sleep(50);
  controller.abort();

  await finishing;
});

void test('A7 a newer signIn aborts the older pending finishSignIn', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.mcp(P1).signIn({ id: created.id });

  const older = rejectsWith(
    world.mcp(P1).finishSignIn({ id: created.id }),
    'mcp_signin_aborted',
  );
  await sleep(50);
  const { url } = await world.mcp(P1).signIn({ id: created.id });

  await older;

  assert.ok(url.startsWith(`${as.issuer}/authorize`));
});

void test('M4b changing the URL of a signed-in server drops its tokens and its signed-in state', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);

  assert.equal(tokenCredentials(world, created.id).length, 2);

  const updated = await world
    .mcp(P1)
    .update({ id: created.id, ...httpServer('docs', plain.url) });

  assert.equal(updated.signedIn, false);

  await eventually(
    () => tokenCredentials(world, created.id).length === 0,
    'the MCP_TOKEN credentials deleted',
    () => tokenCredentials(world, created.id).map((entry) => entry.name),
  );
});

void test('M5 removing a signed-in server deletes its MCP_TOKEN credentials', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);

  assert.equal(tokenCredentials(world, created.id).length, 2);

  await world.mcp(P1).remove({ id: created.id });

  assert.deepEqual(tokenCredentials(world, created.id), []);

  assert.deepEqual(world.liveNames(P1), []);
});

void test('O1 changing the URL of a server cancels its waiting sign-in, whose redirect then stores nothing', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const { url } = await world.mcp(P1).signIn({ id: created.id });
  const approval = as.approve(url);

  const finishing = rejectsWith(
    world.mcp(P1).finishSignIn({ id: created.id }),
    'mcp_signin_aborted',
  );
  await sleep(50);
  await world
    .mcp(P1)
    .update({ id: created.id, ...httpServer('docs', plain.url) });

  await finishing;

  await assert.rejects(followRedirect(approval));

  assert.deepEqual(tokenCredentials(world, created.id), []);
});

void test('O1 removing a server cancels its waiting sign-in', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.mcp(P1).signIn({ id: created.id });

  const finishing = rejectsWith(
    world.mcp(P1).finishSignIn({ id: created.id }),
    'mcp_signin_aborted',
  );
  await sleep(50);
  await world.mcp(P1).remove({ id: created.id });

  await finishing;
});

void test('O2 tokens a sign-in earns after its server moved to another URL are not stored', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const { url } = await world.mcp(P1).signIn({ id: created.id });
  const approval = as.approve(url);
  const release = as.holdTokens();

  const finishing = world
    .mcp(P1)
    .finishSignIn({ id: created.id })
    .then(
      () => 'finished',
      (error: unknown) => codeOf(error),
    );
  await followRedirect(approval);
  await eventually(
    () =>
      as.tokenRequests.some(
        (request) => request.grant_type === 'authorization_code',
      ),
    'the code exchange reaching the authorization server',
  );
  await world
    .mcp(P1)
    .update({ id: created.id, ...httpServer('docs', plain.url) });
  release();

  assert.equal(await finishing, 'mcp_signin_aborted');

  assert.deepEqual(tokenCredentials(world, created.id), []);

  assert.equal(
    serverOf(await world.mcp(P1).list(), created.id)?.signedIn,
    false,
  );
});

void test('O2 a background refresh that answers after its server moved to another URL stores nothing, and the new URL never sees the token', {
  timeout: 30_000,
}, async (t) => {
  const env = createEnvironment();
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const first = await activateWorld(env);
  const created = await first.mcp(P1).create(httpServer('docs', server.url));
  await signInThrough(first, P1, created.id, as);
  await first.deactivate();
  const [old] = as.issued;
  assert.ok(old !== undefined);
  as.accessTokens.delete(old.accessToken);
  const release = as.holdTokens();

  const world = await opened(t, env);
  const watching = world.mcp(P1).watch(() => undefined);
  t.after(() => watching.dispose());
  await eventually(
    () =>
      as.tokenRequests.some(
        (request) => request.grant_type === 'refresh_token',
      ),
    'the refresh reaching the authorization server',
  );
  await world
    .mcp(P1)
    .update({ id: created.id, ...httpServer('docs', plain.url) });
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  release();
  await eventually(
    () => as.issued.length === 2,
    'the refresh answered',
    () => as.issued.length,
  );
  await sleep(200);

  assert.deepEqual(tokenCredentials(world, created.id), []);

  assert.ok(
    plain.requests.every(
      (request) => request.headers.authorization === undefined,
    ),
  );
});

void test('O3 two requests that meet an expired token refresh it one at a time, never reusing a refresh token, and both succeed', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);
  const [signedIn] = as.issued;
  assert.ok(signedIn !== undefined);
  as.accessTokens.delete(signedIn.accessToken);
  const release = as.holdTokens();
  const tool = world.tool(P1, 'mcp__docs__alpha');

  const calls = Promise.allSettled([
    tool.execute({}, world.promptCall(P1)),
    tool.execute({}, world.promptCall(P1)),
  ]);
  await eventually(
    () =>
      as.tokenRequests.some(
        (request) => request.grant_type === 'refresh_token',
      ),
    'a refresh reaching the authorization server',
  );
  await sleep(200);
  release();
  const settled = await calls;

  assert.deepEqual(
    settled.map((result) => result.status),
    ['fulfilled', 'fulfilled'],
  );

  const refreshed = as.tokenRequests
    .filter((request) => request.grant_type === 'refresh_token')
    .map((request) => request.refresh_token);

  assert.equal(new Set(refreshed).size, refreshed.length);

  const access = world.env.credentialNamed(`mcp:${created.id}:access`)?.secret;

  assert.ok(access !== undefined && as.accessTokens.has(access));

  assert.equal(
    serverOf(await world.mcp(P1).list(), created.id)?.signedIn,
    true,
  );
});

void test('O4 a sign-in of another server leaves the waiting one of the first server alone', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const docs = await guarded(t, as, { tools: [textTool('alpha')] });
  const search = await guarded(t, as, { tools: [textTool('beta')] });
  const first = await world.mcp(P1).create(httpServer('docs', docs.url));
  const second = await world.mcp(P1).create(httpServer('search', search.url));
  const { url } = await world.mcp(P1).signIn({ id: first.id });
  const approval = as.approve(url);
  const finishing = world.mcp(P1).finishSignIn({ id: first.id });

  await world.mcp(P1).signIn({ id: second.id });
  await followRedirect(approval);

  assert.equal((await finishing).status.state, 'connected');
});

void test('O5 overlapping signIn calls of one server leave only the latest waiting, with the older callback closed', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const mcp = world.mcp(P1);

  const [older, newer] = await Promise.all([
    mcp.signIn({ id: created.id }),
    mcp.signIn({ id: created.id }),
  ]);
  const stale = as.approve(older.url);
  const live = as.approve(newer.url);
  const finishing = mcp.finishSignIn({ id: created.id });

  await assert.rejects(followRedirect(stale));
  await followRedirect(live);

  assert.equal((await finishing).status.state, 'connected');
});
