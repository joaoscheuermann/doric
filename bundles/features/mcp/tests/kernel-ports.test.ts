// S59a: the kernel's `McpPorts` (`kernelMcpPorts`), each port today's
// `services.use(...)` call: storage/v1, secrets/v1, tools/v1 (an MCP tool
// registered as `toDoricTool`), runtime.lease/v1.withLease and log/v1.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolErrorObject } from 'tool';

import { kernelMcpPorts, type McpToolSource } from '../src/host/ports.js';
import type { CallMcpTool } from '../src/host/tools.js';
import { opened } from './support/setup.js';
import { codeOf, eventually } from './support/wait.js';
import { httpServer, P1, P2, SERVER_TYPE } from './support/world.js';

const weather: Tool = {
  name: 'get.weather/now',
  description: 'Reads the weather now.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
  },
};

const NAME = 'mcp__docs__get_weather_now';

const sourceOf = (tool: Tool = weather, name = NAME) => {
  const requests: Parameters<CallMcpTool>[] = [];
  const source: McpToolSource = {
    name,
    tool,
    callTool: (request, signal) => {
      requests.push([request, signal]);

      return Promise.resolve({ content: [{ type: 'text', text: 'Sunny.' }] });
    },
  };

  return { source, requests };
};

void test('S59a K1 storage reads and writes the storage/v1 documents the bundle keeps', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);
  const created = await world
    .mcp(P1)
    .create(httpServer('Docs', 'https://docs.example/mcp', [], false));

  const stored = await ports.storage.get({ type: SERVER_TYPE, id: created.id });

  assert.deepEqual(stored?.value, world.env.serverDocuments()[0]);

  await ports.storage.commit({
    delete: [{ type: SERVER_TYPE, id: created.id }],
  });

  assert.deepEqual(world.env.serverDocuments(), []);
});

void test('S59a K2 secrets resolves through secrets/v1', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);
  const id = world.env.addCredential('docs-token', 'secret-k2');

  const secret = await ports.secrets.resolve({ id });

  assert.equal(secret.secret, 'secret-k2');

  assert.deepEqual(world.env.secretCalls.resolved, [id]);
});

void test('S59a K3 tools.register registers the MCP tool for the Project at order 1000, not always available, and dispose ends it', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);
  const { source, requests } = sourceOf();

  const registration = await ports.tools.register(source, P1);

  assert.deepEqual(world.liveNames(P1), [NAME]);

  const [entry] = world.live(P1);

  assert.equal(entry?.options.alwaysAvailable, false);

  assert.equal(entry?.options.order, 1000);

  assert.equal(entry?.options.projectId, P1);

  assert.deepEqual(entry?.tool.definition.inputSchema, weather.inputSchema);

  assert.equal(
    await world
      .tool(P1, NAME)
      .execute({ city: 'Lisbon' }, world.promptCall(P1)),
    'Sunny.',
  );

  assert.deepEqual(requests[0]?.[0], {
    name: 'get.weather/now',
    arguments: { city: 'Lisbon' },
  });

  registration.dispose();

  assert.deepEqual(world.liveNames(P1), []);
});

void test('S59a K4 tools.register rejects, registering nothing, for a taken name and for an input schema that is not an object schema', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);
  await ports.tools.register(sourceOf().source, P1);

  await assert.rejects(
    ports.tools.register(sourceOf().source, P1),
    (error: unknown) => {
      assert.equal(codeOf(error), 'duplicate_tool');
      return true;
    },
  );

  await assert.rejects(
    ports.tools.register(
      sourceOf(
        {
          name: 'broken',
          inputSchema: { type: 'string' } as unknown as Tool['inputSchema'],
        },
        'mcp__docs__broken',
      ).source,
      P1,
    ),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_schema',
  );

  assert.equal(world.registrations.length, 1);
});

void test('S59a K5 tools.listed names the tools a call of that Project sees', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);
  await ports.tools.register(sourceOf().source, P1);

  assert.deepEqual([...(await ports.tools.listed(P1))], [NAME]);

  assert.deepEqual([...(await ports.tools.listed(P2))], []);
});

void test('S59a K6 lease.run runs the task on the sandbox the Project holds, and answers the lease status when it cannot', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);

  assert.deepEqual(
    await ports.lease.run(P1, (sandbox) =>
      Promise.resolve(typeof sandbox.start),
    ),
    { status: 'ready', value: 'function' },
  );

  assert.deepEqual(world.env.leased, [P1]);

  world.env.lease = 'pending';
  let ran = false;

  assert.deepEqual(
    await ports.lease.run(P2, () => {
      ran = true;
      return Promise.resolve('never');
    }),
    { status: 'pending' },
  );

  assert.equal(ran, false);

  assert.deepEqual(world.env.leased, [P1, P2]);
});

void test('S59a K7 log reaches log/v1', async (t) => {
  const world = await opened(t);
  const ports = kernelMcpPorts(world.test.services);

  ports.log().warn('Something happened.', { server: 'docs' });
  await eventually(
    () => world.warnings.length > 0,
    'the warning',
    () => world.warnings,
  );

  assert.deepEqual(world.warnings.at(-1), {
    message: 'Something happened.',
    fields: { server: 'docs' },
  });
});
