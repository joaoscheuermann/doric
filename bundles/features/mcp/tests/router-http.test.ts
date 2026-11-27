// HTTP MCP servers over the router (S68c, X3): what `http.test.ts` tested on
// the kernel entry and the router suites T1–T5, H1 (hooks) and S4 do not
// already cover. Each MCP tool becomes a `tools/v1` registration of the
// server's Project, calls go through to the server, and the connection
// follows the Project's life (watch, prompt start, closing) and the part's own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  type FakeTool,
  type HttpMcpServer,
  textTool,
  unreachableUrl,
} from './support/mcp-server.js';
import {
  activated,
  inState,
  listUntil,
  P1,
  type RouterWorld,
  serverOf,
  signInThrough,
} from './support/router.js';
import { authorizing, guarded, served } from './support/setup.js';
import { deferred, eventually, sleep } from './support/wait.js';
import { httpServer, stdioServer } from './support/world.js';

const toolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/;

const lookupSchema: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to look up.', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  },
  required: ['query'],
  additionalProperties: false,
};

const lookup: FakeTool = {
  tool: {
    name: 'lookup',
    description: 'Looks something up.',
    inputSchema: lookupSchema,
  },
  call: () => ({
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ],
  }),
};

/** A server of P1 serving `tools`, connected; answers the world, the server and the id. */
const connected = async (
  t: TestContext,
  name: string,
  tools: readonly FakeTool[],
  options: { readonly mode?: 'sse' } = {},
) => {
  const world = await activated(t);
  const server = await served(t, { tools: [...tools], ...options });
  const created = await world.create(P1, httpServer(name, server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).length === tools.length,
    'the tools registered',
    () => world.registrations,
  );

  return { world, server, id: created.id };
};

/** The live registration of that name under P1. */
const liveRegistration = (world: RouterWorld, name: string) =>
  world.registrations.find(
    (entry) => entry.name === name && !entry.unregistered,
  );

/** Executes the tool; a failure answers as itself, not as a rejection. */
const outcomeOf = async (
  world: RouterWorld,
  name: string,
): Promise<unknown> => {
  try {
    return await world.execute(name, P1, {});
  } catch (error) {
    return error;
  }
};

/** Sends tools/list_changed until the Project's live tools read `names`. */
const changeTools = (
  world: RouterWorld,
  server: HttpMcpServer,
  names: readonly string[],
): Promise<void> =>
  // The notification travels on the server's event stream, which the client
  // opens on its own schedule: send it until the change shows.
  eventually(
    async () => {
      await server.tools.notifyToolsChanged();
      return world.liveNames(P1).join() === names.join();
    },
    'the changed tool list',
    () => world.liveNames(P1),
  );

void test('H1 each MCP tool is registered under the server Project as mcp__<slug>__<tool>', async (t) => {
  const { world } = await connected(t, 'Docs Hub', [lookup, textTool('alpha')]);

  assert.deepEqual(world.liveNames(P1), [
    'mcp__docs_hub__alpha',
    'mcp__docs_hub__lookup',
  ]);
  assert.ok(
    world.registrations
      .filter((entry) => !entry.unregistered)
      .every((entry) => entry.projectId === P1),
  );
});

void test('H2 a registered tool keeps the server input schema verbatim and is not strict', async (t) => {
  const { world } = await connected(t, 'docs', [lookup]);

  const registration = liveRegistration(world, 'mcp__docs__lookup');

  assert.ok(registration !== undefined, JSON.stringify(world.registrations));
  assert.deepEqual(registration.inputSchema, lookupSchema);
  assert.equal(registration.strict ?? false, false);
});

void test('H3 executing a tool answers the server text blocks joined by a blank line', async (t) => {
  const { world, server } = await connected(t, 'docs', [lookup]);

  const result = await world.execute('mcp__docs__lookup', P1, {
    query: 'doric',
  });

  assert.equal(result, 'first\n\nsecond');
  assert.deepEqual(server.tools.calls, [
    { name: 'lookup', arguments: { query: 'doric' } },
  ]);
});

void test('H7 each server receives only its own headers, and only its own credentials are resolved', async (t) => {
  const world = await activated(t);
  const tokenA = world.addCredential('team-a', 'Bearer secret-a');
  const tokenB = world.addCredential('team-b', 'secret-b');
  const serverA = await served(t, { tools: [textTool('alpha')] });
  const serverB = await served(t, { tools: [textTool('beta')] });
  const resolved = () => [
    ...new Set(
      world
        .callsOf('secrets.resolve')
        .map(({ request }) => (request as { id: string }).id),
    ),
  ];

  const a = await world.create(
    P1,
    httpServer('team-a', serverA.url, [
      { name: 'X-Team', value: 'a' },
      { name: 'Authorization', credentialId: tokenA },
    ]),
  );
  await world.watchUntil(P1, inState(a.id, 'connected'), 'A connected');

  assert.deepEqual(resolved(), [tokenA]);

  const b = await world.create(
    P1,
    httpServer('team-b', serverB.url, [
      { name: 'X-Team', value: 'b' },
      { name: 'X-Key', credentialId: tokenB },
    ]),
  );
  await world.watchUntil(P1, inState(b.id, 'connected'), 'B connected');

  assert.deepEqual(resolved().sort(), [tokenA, tokenB].sort());
  assert.ok(serverA.requests.length > 0);
  for (const request of serverA.requests) {
    assert.equal(request.headers['x-team'], 'a');
    assert.equal(request.headers.authorization, 'Bearer secret-a');
    assert.equal(request.headers['x-key'], undefined);
  }
  assert.ok(serverB.requests.length > 0);
  for (const request of serverB.requests) {
    assert.equal(request.headers['x-team'], 'b');
    assert.equal(request.headers['x-key'], 'secret-b');
    assert.equal(request.headers.authorization, undefined);
  }
});

void test('H8 a server that speaks only HTTP+SSE is reached through the fallback', async (t) => {
  const { world } = await connected(t, 'legacy', [textTool('alpha')], {
    mode: 'sse',
  });

  assert.deepEqual(world.liveNames(P1), ['mcp__legacy__alpha']);
  assert.equal(
    await world.execute('mcp__legacy__alpha', P1, { q: 1 }),
    'alpha: {"q":1}',
  );
});

void test('H10 a disabled server reports disabled, is never contacted and registers nothing', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.create(
    P1,
    httpServer('docs', server.url, [], false),
  );

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'disabled'),
    'disabled',
  );
  await sleep(200);

  assert.deepEqual(serverOf(servers, created.id)?.tools, []);
  assert.deepEqual(serverOf(servers, created.id)?.skills, []);
  assert.deepEqual(world.liveNames(P1), []);
  assert.equal(server.requests.length, 0);
});

void test('H11 an unreachable server reports an error with a message and registers nothing', async (t) => {
  const world = await activated(t);
  const created = await world.create(
    P1,
    httpServer('docs', await unreachableUrl()),
  );

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'error'),
    'error',
  );
  const view = serverOf(servers, created.id);

  assert.ok((view?.status.message ?? '').length > 0);
  assert.deepEqual(view?.tools, []);
  assert.deepEqual(view?.skills, []);
  assert.deepEqual(world.liveNames(P1), []);
});

void test('H13 onProjectClosingHook disposes the Project tools and leaves its servers idle', async (t) => {
  const { world, id } = await connected(t, 'docs', [textTool('alpha')]);

  await world.projectClosing(P1);

  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tools disposed',
    () => world.liveNames(P1),
  );
  const servers = await listUntil(world, P1, inState(id, 'idle'), 'idle');
  assert.deepEqual(serverOf(servers, id)?.tools, []);
});

void test('H14 deactivation closes every connection and disposes every tool', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const http = await world.create(P1, httpServer('docs', server.url));
  const stdio = await world.create(P1, stdioServer('files', 'files-mcp'));
  await world.watchUntil(
    P1,
    (servers) =>
      inState(http.id, 'connected')(servers) &&
      inState(stdio.id, 'connected')(servers),
    'both connected',
  );
  await eventually(
    () => world.liveNames(P1).length === 2,
    'both tools registered',
    () => world.registrations,
  );

  await world.deactivate();

  await eventually(
    () => world.registrations.every((entry) => entry.unregistered),
    'every tool unregistered',
    () => world.registrations,
  );
  await eventually(
    () => world.sandbox.started.every((process) => process.terminated),
    'every process terminated',
  );
  await eventually(
    () => server.openStreams() === 0,
    'the HTTP event streams closed',
    () => server.openStreams(),
  );
});

void test('H15 tool names that sanitize alike or run long stay distinct and valid', async (t) => {
  const long = 'x'.repeat(70);
  const { world } = await connected(t, 'docs', [
    textTool('get.weather/now'),
    textTool(long),
    textTool('a.b'),
    textTool('a/b'),
  ]);
  const names = world.liveNames(P1);

  assert.equal(names.length, 4);
  assert.equal(new Set(names).size, 4);
  assert.ok(names.every((name) => toolNamePattern.test(name)));
  assert.ok(names.includes('mcp__docs__get_weather_now'));
  assert.ok(
    names.includes(
      `${`mcp__docs__${long}`.slice(0, 55)}_${createHash('sha256').update(long).digest('hex').slice(0, 8)}`,
    ),
  );
});

void test('H16 a server that forgot the session connects again after a failed call, and its tools work', async (t) => {
  const { world, server, id } = await connected(t, 'docs', [textTool('alpha')]);

  await server.restart();

  assert.ok((await outcomeOf(world, 'mcp__docs__alpha')) instanceof Error);
  await eventually(
    async () => (await outcomeOf(world, 'mcp__docs__alpha')) === 'alpha: {}',
    'the tool working again',
  );
  const servers = await listUntil(
    world,
    P1,
    inState(id, 'connected'),
    'connected',
  );
  assert.deepEqual(
    serverOf(servers, id)?.tools.map((tool) => tool.name),
    ['alpha'],
  );
});

void test('H17 a call whose token expired with no working refresh leaves the server needing sign-in, without its tools', async (t) => {
  const world = await activated(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).length === 1,
    'the tool registered',
    () => world.registrations,
  );
  const tokens = as.issued.at(-1);
  assert.ok(tokens !== undefined);
  // Someone else spends the refresh token; then every access token expires.
  const spent = await fetch(`${as.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });
  await spent.text();
  as.accessTokens.clear();

  assert.ok((await outcomeOf(world, 'mcp__docs__alpha')) instanceof Error);

  const servers = await listUntil(
    world,
    P1,
    inState(created.id, 'needs-sign-in'),
    'needs-sign-in',
  );
  assert.deepEqual(serverOf(servers, created.id)?.tools, []);
  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tool unregistered',
    () => world.registrations,
  );
});

/** An HTTP endpoint that fails Streamable HTTP with `reason` and has no SSE. */
const failing = async (t: TestContext, reason: string): Promise<string> => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(req.method === 'POST' ? 500 : 405, {
      'content-type': 'text/plain',
    });
    res.end(req.method === 'POST' ? reason : 'method not allowed');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
};

void test('H18 a server failing both Streamable HTTP and HTTP+SSE reports the Streamable HTTP failure', async (t) => {
  const world = await activated(t);
  const url = await failing(t, 'the search index is rebuilding');
  const created = await world.create(P1, httpServer('docs', url));

  const servers = await world.watchUntil(
    P1,
    inState(created.id, 'error'),
    'error',
  );

  assert.match(
    serverOf(servers, created.id)?.status.message ?? '',
    /the search index is rebuilding/u,
  );
});

/**
 * Starts a prompt of P1 whose listing of the servers is held, once it read
 * them: `release` lets it answer what it read, `starting` is the prompt start.
 */
const startHeld = async (
  world: RouterWorld,
): Promise<{
  readonly release: () => void;
  readonly starting: Promise<void>;
}> => {
  const gate = deferred<void>();
  const held = { open: gate.promise, held: 0 };
  world.queryGate = held;
  const starting = world.promptStarted(P1);
  await eventually(() => held.held > 0, 'a held listing');

  return {
    release: () => {
      world.queryGate = undefined;
      gate.resolve();
    },
    starting,
  };
};

void test('H19 a server removed while a prompt start lists the Project servers never connects', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  const { release, starting } = await startHeld(world);

  await world.mcp(P1).remove({ id: created.id });
  release();
  await starting;
  await sleep(200);

  assert.deepEqual(world.liveNames(P1), []);
  assert.equal(server.requests.length, 0);
});

void test('H20 a Project closing while a prompt start lists its servers leaves them idle', async (t) => {
  const world = await activated(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', server.url));
  const { release, starting } = await startHeld(world);

  await world.projectClosing(P1);
  release();
  await starting;
  await sleep(200);

  assert.deepEqual(world.liveNames(P1), []);
  assert.equal(server.requests.length, 0);
  assert.ok(inState(created.id, 'idle')(await world.list(P1)));
});

void test('H21 across the bundle envelope, tools/list_changed keeps unchanged tools and replaces a changed one', async (t) => {
  const { world, server } = await connected(t, 'docs', [
    textTool('alpha'),
    textTool('beta'),
  ]);
  const beta = textTool('beta');

  server.tools.setTools([
    textTool('alpha'),
    { ...beta, tool: { ...beta.tool, description: 'The new beta.' } },
    textTool('gamma'),
  ]);
  await eventually(
    async () => {
      await server.tools.notifyToolsChanged();
      return world.liveNames(P1).includes('mcp__docs__gamma');
    },
    'the added tool',
    () => world.liveNames(P1),
  );
  await eventually(
    () =>
      world.registrations.some(
        (entry) =>
          !entry.unregistered &&
          entry.name === 'mcp__docs__beta' &&
          entry.description === 'The new beta.',
      ),
    'the changed tool',
    () => world.registrations,
  );
  await eventually(
    () => world.liveNames(P1).length === 3,
    'the old beta unregistered',
    () => world.registrations,
  );

  assert.deepEqual(world.liveNames(P1), [
    'mcp__docs__alpha',
    'mcp__docs__beta',
    'mcp__docs__gamma',
  ]);
  assert.equal(
    liveRegistration(world, 'mcp__docs__beta')?.description,
    'The new beta.',
  );
  assert.ok(
    world.registrations
      .filter((entry) => entry.name === 'mcp__docs__alpha')
      .every((entry) => !entry.unregistered),
  );
});

void test('H22 a listed tool whose name tools/v1 refuses is left out, and the view shows what is registered', async (t) => {
  const { world, server, id } = await connected(t, 'docs', [textTool('alpha')]);
  world.takenNames.add('mcp__docs__beta');

  server.tools.setTools([
    textTool('alpha'),
    textTool('beta'),
    textTool('gamma'),
  ]);
  await changeTools(world, server, ['mcp__docs__alpha', 'mcp__docs__gamma']);
  const servers = await listUntil(
    world,
    P1,
    (views) =>
      serverOf(views, id)
        ?.tools.map((tool) => tool.name)
        .join() === 'alpha,gamma',
    'the registered tools',
  );

  assert.equal(serverOf(servers, id)?.status.state, 'connected');
  assert.equal(await outcomeOf(world, 'mcp__docs__alpha'), 'alpha: {}');
});

void test('H23 a server is told the default client info unless its transport names another, and an update reconnects with the new one', async (t) => {
  const world = await activated(t);
  const plain = await served(t, { tools: [textTool('alpha')] });
  const named = await served(t, { tools: [textTool('alpha')] });
  const created = await world.create(P1, httpServer('docs', plain.url));
  const renamed = await world.create(P1, {
    name: 'design',
    enabled: true,
    transport: {
      kind: 'http',
      url: named.url,
      headers: [],
      clientInfo: { name: 'claude-code' },
    },
  });
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await world.watchUntil(P1, inState(renamed.id, 'connected'), 'connected');

  assert.deepEqual(plain.tools.clientInfo(), {
    name: 'doric',
    version: '1.0.0',
  });
  assert.deepEqual(named.tools.clientInfo(), {
    name: 'claude-code',
    version: '1.0.0',
  });

  await world.update(P1, renamed.id, {
    name: 'design',
    enabled: true,
    transport: {
      kind: 'http',
      url: named.url,
      headers: [],
      clientInfo: { name: 'claude-code', version: '2.1.0' },
    },
  });

  await eventually(
    () => named.tools.clientInfo()?.version === '2.1.0',
    'reconnected with the new client version',
    () => named.tools.clientInfo(),
  );
});
