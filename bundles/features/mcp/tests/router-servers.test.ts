// M1–M5, M10 (phase 3, S59c): `mcp/v1` over the router. A call without a
// Project is refused on both services; `Create` trims, stores the kernel's
// document and refuses a taken slug (FAILED_PRECONDITION), an MCP_TOKEN entry
// and what protovalidate refuses; `Update` of a moved server forgets its
// sign-in; `Remove` forgets a server of its own Project only; `ReadSkill`
// reads a listed skill of a connected server.

import assert from 'node:assert/strict';
import test from 'node:test';

import { Code } from '@connectrpc/connect';
import { createdKey } from 'runtime/contracts';

import { fakeSkill, textTool } from './support/mcp-server.js';
import {
  activated,
  failureOf,
  inputMessage,
  inState,
  P1,
  P2,
  signInThrough,
  statusOf,
} from './support/router.js';
import { authorizing, guarded, served } from './support/setup.js';
import { eventually } from './support/wait.js';
import { httpServer, stdioServer } from './support/world.js';

/** The MCP_TOKEN credentials the fake secrets/v1 holds for a server. */
const tokensOf = (
  world: Awaited<ReturnType<typeof activated>>,
  id: string,
): readonly string[] =>
  [...world.credentials.values()]
    .filter(
      (entry) =>
        entry.kind === 'MCP_TOKEN' && entry.name.startsWith(`mcp:${id}:`),
    )
    .map((entry) => entry.name)
    .sort();

void test('M1: a call without a Project is refused invalid_input "mcp/v1 needs a Project scope." on both services', async (t) => {
  const world = await activated(t);

  const listed = await failureOf(() => world.mcp(undefined).list({}));
  const sources = await failureOf(() =>
    world.skillSources(undefined).list({ cwd: '' }),
  );

  assert.deepEqual(
    [listed, sources].map(({ code, message }) => ({ code, message })),
    [
      { code: 'invalid_input', message: 'mcp/v1 needs a Project scope.' },
      { code: 'invalid_input', message: 'mcp/v1 needs a Project scope.' },
    ],
  );
});

void test("M2: Create trims the name, answers idle and stores the kernel's document; a taken slug is mcp_server_name_taken (FAILED_PRECONDITION); an MCP_TOKEN entry is invalid_input and stores nothing", async (t) => {
  const world = await activated(t);
  const url = 'https://docs.example.com/mcp';

  const view = await world.create(P1, httpServer('  Docs  ', url));

  assert.equal(view.name, 'Docs');
  assert.equal(view.status.state, 'idle');
  const [document] = world.documents();
  assert.ok(document !== undefined, 'the document is stored');
  assert.deepEqual(document, {
    name: 'Docs',
    enabled: true,
    transport: { kind: 'http', url, headers: [] },
    id: view.id,
    projectId: P1,
    createdKey: createdKey(String(document.createdAt), view.id),
    createdAt: document.createdAt,
    updatedAt: document.createdAt,
  });

  const taken = await failureOf(() =>
    world.create(P1, httpServer('docs!', url)),
  );
  const status = await statusOf(() =>
    world.mcp(P1).create({
      mcpServerInput: inputMessage(httpServer('docs!', url)),
    }),
  );
  assert.equal(taken.code, 'mcp_server_name_taken');
  assert.equal(status, Code.FailedPrecondition);

  const token = world.addCredential(`mcp:${view.id}:access`, 't', 'MCP_TOKEN');
  const refused = await failureOf(() =>
    world.create(
      P1,
      httpServer('Other', url, [
        { name: 'Authorization', credentialId: token },
      ]),
    ),
  );
  assert.equal(refused.code, 'invalid_input');
  assert.equal(world.documents().length, 1);
});

void test('M3: Create with an empty scopes list stores no scopes; an ftp URL is refused invalid_input by protovalidate', async (t) => {
  const world = await activated(t);

  await world.create(P1, {
    name: 'Docs',
    enabled: true,
    transport: {
      kind: 'http',
      url: 'https://docs.example.com/mcp',
      headers: [],
      scopes: [],
    },
  });
  const ftp = await failureOf(() =>
    world.create(P1, httpServer('Files', 'ftp://x')),
  );

  const [document] = world.documents();
  assert.ok(document !== undefined);
  assert.ok(
    !('scopes' in (document.transport as Record<string, unknown>)),
    JSON.stringify(document.transport),
  );
  assert.equal(ftp.code, 'invalid_input');
  assert.equal(world.documents().length, 1);
});

void test('M4: Update to a new URL deletes the MCP_TOKEN credentials, drops oauth and aborts a waiting sign-in; changing only clientName keeps the tokens', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const moved = await served(t, { tools: [textTool('beta')] });
  const docs = await world.create(P1, httpServer('docs', server.url));
  const kept = await world.create(P1, httpServer('kept', server.url));
  await signInThrough(world, P1, docs.id, as);
  await signInThrough(world, P1, kept.id, as);
  assert.equal(tokensOf(world, docs.id).length, 2);

  await world.mcp(P1).signIn({ id: docs.id });
  const waiting = failureOf(() => world.mcp(P1).finishSignIn({ id: docs.id }));
  await world.update(P1, docs.id, httpServer('docs', moved.url));

  assert.equal((await waiting).code, 'mcp_signin_aborted');
  assert.deepEqual(tokensOf(world, docs.id), []);
  const document = world.documents().find((entry) => entry.id === docs.id);
  assert.ok(document !== undefined && !('oauth' in document));

  await world.update(P1, kept.id, {
    name: 'kept',
    enabled: true,
    transport: {
      kind: 'http',
      url: server.url,
      headers: [],
      clientName: 'Doric',
    },
  });

  assert.deepEqual(tokensOf(world, kept.id), [
    `mcp:${kept.id}:access`,
    `mcp:${kept.id}:refresh`,
  ]);
});

void test("M5: Remove of another Project's server is mcp_server_missing; of its own forgets the document, deletes its credentials and unregisters its tools", async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);
  await eventually(
    () => world.liveNames(P1).length === 1,
    'the tool registered',
    () => world.registrations,
  );

  const other = await failureOf(() => world.mcp(P2).remove({ id: created.id }));
  assert.equal(other.code, 'mcp_server_missing');
  assert.equal(world.documents().length, 1);

  await world.mcp(P1).remove({ id: created.id });

  assert.deepEqual(world.documents(), []);
  assert.deepEqual(tokensOf(world, created.id), []);
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tool unregistered',
    () => world.registrations,
  );
  assert.ok(world.callsOf('tools.unregister').length >= 1);
});

void test('M8: SignIn of a stdio server is mcp_signin_unsupported; FinishSignIn without a start is mcp_signin_not_started', async (t) => {
  const world = await activated(t);
  const stdio = await world.create(P1, stdioServer('files', 'node'));
  const http = await world.create(
    P1,
    httpServer('docs', 'https://docs.example.com/mcp'),
  );

  const unsupported = await failureOf(() =>
    world.mcp(P1).signIn({ id: stdio.id }),
  );
  const notStarted = await failureOf(() =>
    world.mcp(P1).finishSignIn({ id: http.id }),
  );

  assert.equal(unsupported.code, 'mcp_signin_unsupported');
  assert.equal(notStarted.code, 'mcp_signin_not_started');
});

void test("M10: ReadSkill answers a connected server's listed skill text; an unlisted uri is mcp_skill_unavailable", async (t) => {
  const world = await activated(t);
  const text = '---\nname: refunds\n---\n\n# Refunds\n';
  const server = await served(t, {
    tools: [textTool('alpha')],
    skills: [[{ ...fakeSkill('refunds', 'Issue a refund.'), text }]],
  });
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  const read = await world
    .mcp(P1)
    .readSkill({ id: created.id, uri: 'skill://refunds/SKILL.md' });
  const unlisted = await failureOf(() =>
    world.mcp(P1).readSkill({ id: created.id, uri: 'skill://triage/SKILL.md' }),
  );

  assert.equal(read.text, text);
  assert.equal(unlisted.code, 'mcp_skill_unavailable');
});
