// OAuth for HTTP MCP servers over the router (S68c, X3): what `oauth.test.ts`
// tested on the kernel entry and the router suites M4, M5, M8 and M9 do not
// already cover. A background connect never registers a client or opens a
// browser, sign-in is PKCE with the server as the resource, the tokens live
// only in `secrets/v1` as MCP_TOKEN credentials, and they follow the server's
// configuration.

import assert from 'node:assert/strict';
import test from 'node:test';

import { textTool } from './support/mcp-server.js';
import { followRedirect } from './support/oauth-server.js';
import {
  activated,
  failureOf,
  inState,
  P1,
  type RouterWorld,
  reactivated,
  serverOf,
  signInThrough,
  tokenCredentials,
  viewOf,
} from './support/router.js';
import { authorizing, guarded, served } from './support/setup.js';
import { eventually, sleep } from './support/wait.js';
import { httpServer } from './support/world.js';

/** The code `call` failed with. */
const codeOfFailure = async (call: () => Promise<unknown>): Promise<string> =>
  (await failureOf(call)).code;

/** `FinishSignIn` of the server, answering its view. */
const finishSignIn = async (
  world: RouterWorld,
  id: string,
  options: { readonly signal?: AbortSignal } = {},
) => {
  const { mcpServerView } = await world
    .mcp(P1)
    .finishSignIn({ id }, options.signal === undefined ? {} : options);
  if (mcpServerView === undefined) throw new Error('No view answered.');

  return viewOf(mcpServerView);
};

/** The secret of the credential of that name. */
const secretNamed = (world: RouterWorld, name: string) =>
  [...world.credentials.values()].find((entry) => entry.name === name)?.secret;

/** Keeps a `Watch` of the Project open until the test ends. */
const watching = (t: test.TestContext, world: RouterWorld) => {
  const controller = new AbortController();
  t.after(() => controller.abort());
  void (async () => {
    try {
      for await (const _item of world
        .mcp(P1)
        .watch({}, { signal: controller.signal })) {
        // Each item is the Project's servers now; only the open stream matters.
      }
    } catch {
      // Cancelled when the test ends.
    }
  })();
};

void test('A1 a server answering 401 with resource metadata needs sign-in, and no client is registered', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));

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
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));

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

void test('A4 a callback whose iss differs from the advertised issuer fails sign-in and stores no token', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t, { issParameterSupported: true });
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));

  const { url } = await world.mcp(P1).signIn({ id: created.id });
  const approval = as.approve(url);
  const finishing = codeOfFailure(() => finishSignIn(world, created.id));
  await followRedirect(approval, { iss: 'http://evil.example' });

  assert.equal(await finishing, 'mcp_signin_failed');
  assert.deepEqual(tokenCredentials(world, created.id), []);
  assert.ok(
    !world
      .callsOf('secrets.create')
      .some(
        ({ request }) => (request as { kind: string }).kind === 'MCP_TOKEN',
      ),
  );
});

for (const [label, codeChallengeMethods] of [
  ['without code_challenge_methods_supported', null],
  ['supporting only plain', ['plain']],
] as const) {
  void test(`A5 an authorization server ${label} fails signIn`, async (t) => {
    const world = await activated(t);
    const as = await authorizing(t, { codeChallengeMethods });
    const server = await guarded(t, as, { tools: [textTool('alpha')] });
    const created = await world.create(P1, httpServer('docs', server.url));

    assert.equal(
      await codeOfFailure(() => world.mcp(P1).signIn({ id: created.id })),
      'mcp_signin_failed',
    );
  });
}

void test('A6 a new activation with an expired access token refreshes it and connects without sign-in', async (t) => {
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const first = await activated(t);
  const created = await first.create(P1, httpServer('docs', server.url));
  await signInThrough(first, P1, created.id, as);
  await first.deactivate();
  const [old] = as.issued;
  assert.ok(old !== undefined);
  as.accessTokens.delete(old.accessToken);

  const world = await reactivated(t, first);
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
    secretNamed(world, `mcp:${created.id}:access`),
    refreshed?.accessToken,
  );
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__docs__alpha',
    'the tool registered',
    () => world.registrations,
  );
});

void test('A7 aborting the finishSignIn call rejects it as aborted', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.mcp(P1).signIn({ id: created.id });
  const controller = new AbortController();

  const finishing = finishSignIn(world, created.id, {
    signal: controller.signal,
  });
  await sleep(50);
  controller.abort();

  // Over the wire the caller sees its own cancel; the call rejects, it
  // never answers a view.
  await assert.rejects(finishing);
  assert.deepEqual(tokenCredentials(world, created.id), []);
});

void test('A7 a newer signIn aborts the older pending finishSignIn', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.mcp(P1).signIn({ id: created.id });

  const older = codeOfFailure(() => finishSignIn(world, created.id));
  await sleep(50);
  const { url } = await world.mcp(P1).signIn({ id: created.id });

  assert.equal(await older, 'mcp_signin_aborted');
  assert.ok(url.startsWith(`${as.issuer}/authorize`));
});

void test('A8 a sign-in registers its client as Doric unless the server names another client', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await world.create(P1, httpServer('docs', server.url));
  const named = await world.create(P1, {
    name: 'design',
    enabled: true,
    transport: {
      kind: 'http',
      url: server.url,
      headers: [],
      clientName: '  Claude Code ',
    },
  });

  await world.mcp(P1).signIn({ id: plain.id });
  await world.mcp(P1).signIn({ id: named.id });

  assert.deepEqual(
    as.registrations.map((registration) => registration.client_name),
    ['Doric', 'Claude Code'],
  );
});

void test('A8 changing only the client name keeps the tokens, and the next sign-in registers under the new name', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);

  const updated = await world.update(P1, created.id, {
    name: 'docs',
    enabled: true,
    transport: {
      kind: 'http',
      url: server.url,
      headers: [],
      clientName: 'Claude Code',
    },
  });

  assert.equal(updated.signedIn, true);
  assert.equal(tokenCredentials(world, created.id).length, 2);
  await world.mcp(P1).signIn({ id: created.id });
  assert.equal(as.registrations.at(-1)?.client_name, 'Claude Code');
});

void test('A9 a sign-in asks for the scopes the server names unless the transport names its own', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, {
    tools: [textTool('alpha')],
    scopesSupported: ['files:read'],
  });
  const plain = await world.create(P1, httpServer('docs', server.url));
  const scoped = await world.create(P1, {
    name: 'design',
    enabled: true,
    transport: {
      kind: 'http',
      url: server.url,
      headers: [],
      scopes: ['files:read', 'files:write'],
    },
  });

  const plainUrl = new URL((await world.mcp(P1).signIn({ id: plain.id })).url);
  const scopedUrl = new URL(
    (await world.mcp(P1).signIn({ id: scoped.id })).url,
  );

  assert.equal(plainUrl.searchParams.get('scope'), 'files:read');
  assert.equal(scopedUrl.searchParams.get('scope'), 'files:read files:write');
  assert.deepEqual(
    as.registrations.map((registration) => registration.scope),
    ['files:read', 'files:read files:write'],
  );
});

void test('A9 changing only the scopes and the client info keeps the tokens, and the next sign-in asks for the new scopes', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);

  const updated = await world.update(P1, created.id, {
    name: 'docs',
    enabled: true,
    transport: {
      kind: 'http',
      url: server.url,
      headers: [],
      scopes: ['files:write'],
      clientInfo: { name: 'claude-code' },
    },
  });

  assert.equal(updated.signedIn, true);
  assert.equal(tokenCredentials(world, created.id).length, 2);
  const { url } = await world.mcp(P1).signIn({ id: created.id });
  assert.equal(new URL(url).searchParams.get('scope'), 'files:write');
});

void test('O1 changing the URL of a server cancels its waiting sign-in, whose redirect then stores nothing', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  const { url } = await world.mcp(P1).signIn({ id: created.id });
  const approval = as.approve(url);

  const finishing = codeOfFailure(() => finishSignIn(world, created.id));
  await sleep(50);
  await world.update(P1, created.id, httpServer('docs', plain.url));

  assert.equal(await finishing, 'mcp_signin_aborted');
  await assert.rejects(followRedirect(approval));
  assert.deepEqual(tokenCredentials(world, created.id), []);
});

void test('O1 removing a server cancels its waiting sign-in', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.mcp(P1).signIn({ id: created.id });

  const finishing = codeOfFailure(() => finishSignIn(world, created.id));
  await sleep(50);
  await world.mcp(P1).remove({ id: created.id });

  assert.equal(await finishing, 'mcp_signin_aborted');
});

void test('O2 tokens a sign-in earns after its server moved to another URL are not stored', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  const { url } = await world.mcp(P1).signIn({ id: created.id });
  const approval = as.approve(url);
  const release = as.holdTokens();

  const finishing = finishSignIn(world, created.id).then(
    () => 'finished',
    (error: unknown) => failureOf(() => Promise.reject(error)),
  );
  await followRedirect(approval);
  await eventually(
    () =>
      as.tokenRequests.some(
        (request) => request.grant_type === 'authorization_code',
      ),
    'the code exchange reaching the authorization server',
  );
  await world.update(P1, created.id, httpServer('docs', plain.url));
  release();

  const outcome = await finishing;
  assert.equal(
    typeof outcome === 'string' ? outcome : outcome.code,
    'mcp_signin_aborted',
  );
  assert.deepEqual(tokenCredentials(world, created.id), []);
  assert.equal(serverOf(await world.list(P1), created.id)?.signedIn, false);
});

void test('O2 a background refresh that answers after its server moved to another URL stores nothing, and the new URL never sees the token', {
  timeout: 30_000,
}, async (t) => {
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const plain = await served(t, { tools: [textTool('beta')] });
  const first = await activated(t);
  const created = await first.create(P1, httpServer('docs', server.url));
  await signInThrough(first, P1, created.id, as);
  await first.deactivate();
  const [old] = as.issued;
  assert.ok(old !== undefined);
  as.accessTokens.delete(old.accessToken);
  const release = as.holdTokens();

  const world = await reactivated(t, first);
  watching(t, world);
  await eventually(
    () =>
      as.tokenRequests.some(
        (request) => request.grant_type === 'refresh_token',
      ),
    'the refresh reaching the authorization server',
  );
  await world.update(P1, created.id, httpServer('docs', plain.url));
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
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__docs__alpha',
    'the tool registered',
    () => world.registrations,
  );
  const [signedIn] = as.issued;
  assert.ok(signedIn !== undefined);
  as.accessTokens.delete(signedIn.accessToken);
  const release = as.holdTokens();

  const calls = Promise.allSettled([
    world.execute('mcp__docs__alpha', P1, {}),
    world.execute('mcp__docs__alpha', P1, {}),
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
  const access = secretNamed(world, `mcp:${created.id}:access`);
  assert.ok(access !== undefined && as.accessTokens.has(access));
  assert.equal(serverOf(await world.list(P1), created.id)?.signedIn, true);
});

void test('O4 a sign-in of another server leaves the waiting one of the first server alone', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const docs = await guarded(t, as, { tools: [textTool('alpha')] });
  const search = await guarded(t, as, { tools: [textTool('beta')] });
  const first = await world.create(P1, httpServer('docs', docs.url));
  const second = await world.create(P1, httpServer('search', search.url));
  const { url } = await world.mcp(P1).signIn({ id: first.id });
  const approval = as.approve(url);
  const finishing = finishSignIn(world, first.id);

  await world.mcp(P1).signIn({ id: second.id });
  await followRedirect(approval);

  assert.equal((await finishing).status.state, 'connected');
});

void test('O5 overlapping signIn calls of one server leave only the latest waiting, with the older callback closed', {
  timeout: 30_000,
}, async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  const mcp = world.mcp(P1);

  const [older, newer] = await Promise.all([
    mcp.signIn({ id: created.id }),
    mcp.signIn({ id: created.id }),
  ]);
  const stale = as.approve(older.url);
  const live = as.approve(newer.url);
  const finishing = finishSignIn(world, created.id);

  await assert.rejects(followRedirect(stale));
  await followRedirect(live);

  assert.equal((await finishing).status.state, 'connected');
});
