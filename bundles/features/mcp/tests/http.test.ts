// HTTP MCP servers reached from the host: each MCP tool becomes a Doric tool
// of the server's Project, calls go through to the server, and the
// connection follows the Project's life (watch, prompt start, closing) and
// the bundle's own.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolsV1 } from 'bundle/contracts';
import { attachmentReferences } from 'runtime/contracts';
import { defineTool } from 'tool';
import { z } from 'zod';

import {
  type FakeTool,
  type HttpMcpServer,
  textTool,
  unreachableUrl,
} from './support/mcp-server.js';
import { authorizing, guarded, opened, served } from './support/setup.js';
import { signInThrough } from './support/sign-in.js';
import { codeOf, deferred, eventually, sleep } from './support/wait.js';
import {
  activateWorld,
  createEnvironment,
  httpServer,
  inState,
  P1,
  REMOTE_DISPOSE_MS,
  serverOf,
  stdioServer,
  type World,
} from './support/world.js';

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

void test('H1 each MCP tool is registered under the server Project as mcp__<slug>__<tool>', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [lookup, textTool('alpha')] });
  const created = await world
    .mcp(P1)
    .create(httpServer('Docs Hub', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  assert.deepEqual(world.liveNames(P1), [
    'mcp__docs_hub__alpha',
    'mcp__docs_hub__lookup',
  ]);

  assert.ok(world.live(P1).every((entry) => entry.options.projectId === P1));
});

void test('H2 a registered tool keeps the server input schema verbatim and is not strict', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [lookup] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  const tool = world.tool(P1, 'mcp__docs__lookup');

  assert.deepEqual(tool.definition.inputSchema, lookupSchema);

  assert.equal(tool.definition.strict, false);
});

void test('H3 executing a tool answers the server text blocks joined by a blank line', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [lookup] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  const result = await world
    .tool(P1, 'mcp__docs__lookup')
    .execute({ query: 'doric' }, world.promptCall(P1));

  assert.equal(result, 'first\n\nsecond');

  assert.deepEqual(server.tools.calls, [
    { name: 'lookup', arguments: { query: 'doric' } },
  ]);
});

void test('H4 a result flagged isError rejects with mcp_tool_failed and the server text', async (t) => {
  const world = await opened(t);
  const failing: FakeTool = {
    tool: { name: 'quota', inputSchema: { type: 'object' } },
    call: () => ({
      content: [{ type: 'text', text: 'Quota exceeded for today.' }],
      isError: true,
    }),
  };
  const server = await served(t, { tools: [failing] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await assert.rejects(
    world.tool(P1, 'mcp__docs__quota').execute({}, world.promptCall(P1)),
    (error: unknown) => {
      assert.equal(codeOf(error), 'mcp_tool_failed');
      assert.match((error as Error).message, /Quota exceeded for today\./u);
      return true;
    },
  );
});

void test('H5 an image block is attached to the Project and answered as its reference line', async (t) => {
  const world = await opened(t);
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
  ]).toString('base64');
  const chart: FakeTool = {
    tool: { name: 'chart', inputSchema: { type: 'object' } },
    call: () => ({
      content: [
        { type: 'text', text: 'Here is the chart.' },
        { type: 'image', data: png, mimeType: 'image/png' },
      ],
    }),
  };
  const server = await served(t, { tools: [chart] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  const result = await world
    .tool(P1, 'mcp__docs__chart')
    .execute({}, world.promptCall(P1));

  assert.deepEqual(
    world.attached.map((input) => input.bytes),
    [png],
  );

  assert.equal(typeof result, 'string');

  assert.ok((result as string).startsWith('Here is the chart.\n\n'));

  assert.deepEqual(
    attachmentReferences(result as string).map((reference) => reference.id),
    [world.attachments[0]?.id],
  );
});

void test('H6 aborting the prompt call rejects the tool execution', {
  timeout: 30_000,
}, async (t) => {
  const world = await opened(t);
  const started = deferred<void>();
  const slow: FakeTool = {
    tool: { name: 'slow', inputSchema: { type: 'object' } },
    call: (_args, signal) =>
      new Promise((resolve) => {
        started.resolve();
        signal.addEventListener('abort', () => {
          resolve({ content: [{ type: 'text', text: 'cancelled' }] });
        });
      }),
  };
  const server = await served(t, { tools: [slow] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  const controller = new AbortController();

  const running = world
    .tool(P1, 'mcp__docs__slow')
    .execute({}, world.promptCall(P1, controller.signal));
  await started.promise;
  controller.abort();

  await assert.rejects(running);
});

void test('H7 each server receives only its own headers, and only its own credentials are resolved', async (t) => {
  const world = await opened(t);
  const tokenA = world.env.addCredential('team-a', 'Bearer secret-a');
  const tokenB = world.env.addCredential('team-b', 'secret-b');
  const serverA = await served(t, { tools: [textTool('alpha')] });
  const serverB = await served(t, { tools: [textTool('beta')] });

  const a = await world.mcp(P1).create(
    httpServer('team-a', serverA.url, [
      { name: 'X-Team', value: 'a' },
      { name: 'Authorization', credentialId: tokenA },
    ]),
  );
  await world.watchUntil(P1, inState(a.id, 'connected'), 'A connected');

  assert.deepEqual([...new Set(world.env.secretCalls.resolved)], [tokenA]);

  const b = await world.mcp(P1).create(
    httpServer('team-b', serverB.url, [
      { name: 'X-Team', value: 'b' },
      { name: 'X-Key', credentialId: tokenB },
    ]),
  );
  await world.watchUntil(P1, inState(b.id, 'connected'), 'B connected');

  assert.deepEqual(
    [...new Set(world.env.secretCalls.resolved)].sort(),
    [tokenA, tokenB].sort(),
  );

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
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')], mode: 'sse' });
  const created = await world.mcp(P1).create(httpServer('legacy', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  assert.deepEqual(world.liveNames(P1), ['mcp__legacy__alpha']);

  const result = await world
    .tool(P1, 'mcp__legacy__alpha')
    .execute({ q: 1 }, world.promptCall(P1));

  assert.equal(result, 'alpha: {"q":1}');
});

void test('H9 tools/list_changed disposes a removed tool and registers an added one', async (t) => {
  const world = await opened(t);
  const server = await served(t, {
    tools: [textTool('alpha'), textTool('beta')],
  });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  server.tools.setTools([textTool('alpha'), textTool('gamma')]);
  // The notification travels on the server's event stream, which the client
  // opens on its own schedule: send it until the change shows.
  await eventually(
    async () => {
      await server.tools.notifyToolsChanged();
      return world.liveNames(P1).join() === 'mcp__docs__alpha,mcp__docs__gamma';
    },
    'the changed tool list',
    () => world.liveNames(P1),
  );

  assert.ok(
    world.registrations
      .filter((entry) => entry.tool.name === 'mcp__docs__beta')
      .every((entry) => entry.disposed),
  );
});

void test('H10 a disabled server reports disabled, is never contacted and registers nothing', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world
    .mcp(P1)
    .create(httpServer('docs', server.url, [], false));

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
  const world = await opened(t);
  const created = await world
    .mcp(P1)
    .create(httpServer('docs', await unreachableUrl()));

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

void test('H12 onPromptStartedHook for a Project resolves only once its servers tools are registered', async (t) => {
  const env = createEnvironment();
  const server = await served(t, { tools: [textTool('alpha')] });
  const first = await activateWorld(env);
  await first.mcp(P1).create(httpServer('docs', server.url));
  await first.deactivate();

  const world = await opened(t, env);
  await world.promptStarted(P1);

  assert.deepEqual(world.liveNames(P1), ['mcp__docs__alpha']);

  assert.ok(world.live(P1).every((entry) => entry.options.projectId === P1));
});

void test('H13 onProjectClosingHook disposes the Project tools and leaves its servers idle', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await world.projectClosing(P1);

  await eventually(
    () => world.liveNames(P1).length === 0,
    'the tools disposed',
    () => world.liveNames(P1),
  );
  const servers = await world.listUntil(
    P1,
    inState(created.id, 'idle'),
    'idle',
  );

  assert.deepEqual(serverOf(servers, created.id)?.tools, []);
});

void test('H14 deactivation closes every connection and disposes every tool', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const http = await world.mcp(P1).create(httpServer('docs', server.url));
  const stdio = await world.mcp(P1).create(stdioServer('files', 'files-mcp'));
  await world.watchUntil(
    P1,
    (servers) =>
      inState(http.id, 'connected')(servers) &&
      inState(stdio.id, 'connected')(servers),
    'both connected',
  );

  assert.equal(world.liveNames(P1).length, 2);

  await world.deactivate();

  assert.ok(world.registrations.every((entry) => entry.disposed));

  assert.ok(world.env.sandbox.started.every((process) => process.terminated));

  await eventually(
    () => server.openStreams() === 0,
    'the HTTP event streams closed',
    () => server.openStreams(),
  );
});

void test('H15 tool names that sanitize alike or run long stay distinct and valid', async (t) => {
  const world = await opened(t);
  const long = 'x'.repeat(70);
  const server = await served(t, {
    tools: [
      textTool('get.weather/now'),
      textTool(long),
      textTool('a.b'),
      textTool('a/b'),
    ],
  });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
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

/** Executes the tool; a failure answers as itself, not as a rejection. */
const outcomeOf = async (world: World, name: string): Promise<unknown> => {
  try {
    return await world.tool(P1, name).execute({}, world.promptCall(P1));
  } catch (error) {
    return error;
  }
};

/** Sends tools/list_changed until the Project's live tools read `names`. */
const changeTools = (
  world: World,
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

void test('H16 a server that forgot the session connects again after a failed call, and its tools work', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  await server.restart();

  assert.ok((await outcomeOf(world, 'mcp__docs__alpha')) instanceof Error);

  await eventually(
    async () => (await outcomeOf(world, 'mcp__docs__alpha')) === 'alpha: {}',
    'the tool working again',
  );
  const servers = await world.listUntil(
    P1,
    inState(created.id, 'connected'),
    'connected',
  );

  assert.deepEqual(
    serverOf(servers, created.id)?.tools.map((tool) => tool.name),
    ['alpha'],
  );
});

void test('H17 a call whose token expired with no working refresh leaves the server needing sign-in, without its tools', async (t) => {
  const world = await opened(t);
  const as = await authorizing(t);
  const server = await guarded(t, as, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await signInThrough(world, P1, created.id, as);
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
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

  const servers = await world.listUntil(
    P1,
    inState(created.id, 'needs-sign-in'),
    'needs-sign-in',
  );

  assert.deepEqual(serverOf(servers, created.id)?.tools, []);

  assert.deepEqual(world.liveNames(P1), []);
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

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
};

void test('H18 a server failing both Streamable HTTP and HTTP+SSE reports the Streamable HTTP failure', async (t) => {
  const world = await opened(t);
  const url = await failing(t, 'the search index is rebuilding');
  const created = await world.mcp(P1).create(httpServer('docs', url));

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
  world: World,
): Promise<{
  readonly release: () => void;
  readonly starting: Promise<void>;
}> => {
  const gate = deferred<void>();
  const held = { open: gate.promise, held: 0 };
  world.env.queryGate = held;
  const starting = world.promptStarted(P1);
  await eventually(() => held.held > 0, 'a held listing');

  return {
    release: () => {
      world.env.queryGate = undefined;
      gate.resolve();
    },
    starting,
  };
};

void test('H19 a server removed while a prompt start lists the Project servers never connects', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const { release, starting } = await startHeld(world);

  await world.mcp(P1).remove({ id: created.id });
  release();
  await starting;
  await sleep(200);

  assert.deepEqual(world.liveNames(P1), []);

  assert.equal(server.requests.length, 0);
});

void test('H20 a Project closing while a prompt start lists its servers leaves them idle', async (t) => {
  const world = await opened(t);
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  const { release, starting } = await startHeld(world);

  await world.projectClosing(P1);
  release();
  await starting;
  await sleep(200);

  assert.deepEqual(world.liveNames(P1), []);

  assert.equal(server.requests.length, 0);

  assert.ok(inState(created.id, 'idle')(await world.mcp(P1).list()));
});

void test('H21 across the bundle envelope, tools/list_changed keeps unchanged tools and replaces a changed one', async (t) => {
  const env = createEnvironment();
  env.registry = 'remote';
  const world = await opened(t, env);
  const server = await served(t, {
    tools: [textTool('alpha'), textTool('beta')],
  });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
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
      world
        .live(P1)
        .some(
          (entry) =>
            entry.tool.name === 'mcp__docs__beta' &&
            entry.tool.description === 'The new beta.',
        ),
    'the changed tool',
    () => world.liveNames(P1),
  );
  // Every dispose sent so far has reached the registry.
  await sleep(REMOTE_DISPOSE_MS * 3);

  assert.deepEqual(world.liveNames(P1), [
    'mcp__docs__alpha',
    'mcp__docs__beta',
    'mcp__docs__gamma',
  ]);

  assert.equal(world.tool(P1, 'mcp__docs__beta').description, 'The new beta.');

  assert.deepEqual(world.refused, []);

  assert.ok(
    world.registrations
      .filter((entry) => entry.tool.name === 'mcp__docs__alpha')
      .every((entry) => !entry.disposed),
  );
});

void test('H22 a listed tool whose name tools/v1 refuses is left out, and the view shows what is registered', async (t) => {
  const world = await opened(t);
  const taken = world.test.services.use(ToolsV1).register(
    defineTool({
      name: 'mcp__docs__beta',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'built in',
    }),
    { alwaysAvailable: false },
  );
  t.after(() => taken.dispose());
  const server = await served(t, { tools: [textTool('alpha')] });
  const created = await world.mcp(P1).create(httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');

  server.tools.setTools([
    textTool('alpha'),
    textTool('beta'),
    textTool('gamma'),
  ]);
  await changeTools(world, server, ['mcp__docs__alpha', 'mcp__docs__gamma']);
  const servers = await world.listUntil(
    P1,
    (views) =>
      serverOf(views, created.id)
        ?.tools.map((tool) => tool.name)
        .join() === 'alpha,gamma',
    'the registered tools',
  );

  assert.equal(serverOf(servers, created.id)?.status.state, 'connected');

  assert.equal(await outcomeOf(world, 'mcp__docs__alpha'), 'alpha: {}');
});
