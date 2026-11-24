// T1–T5 (phase 3, S59c): the MCP tools of a connected server over the
// router. Each is `tools/v1.Register`ed for the server's Project
// (`mcp__<slug>__<tool>`, order 1000, not always available) and served by the
// bundle's `ToolHandlerService`: `Execute` calls the server's tool with its
// MCP name and the arguments and answers its text; `isError` fails
// `mcp_tool_failed`; an image is kept through `runtime.attachments/v1.Attach`
// under the `Execute` call's scope; cancelling `Execute` cancels the MCP
// request; a renamed tool is unregistered and the new one registered.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';
import { attachmentReference } from 'runtime/contracts';

import { type FakeTool, textTool } from './support/mcp-server.js';
import {
  activated,
  failureOf,
  inState,
  P1,
  PROMPT,
  type RouterWorld,
  THREAD,
} from './support/router.js';
import { served } from './support/setup.js';
import { eventually } from './support/wait.js';
import { httpServer } from './support/world.js';

const ATTACHMENT_ID = `sha256-${'a'.repeat(64)}`;

/** A `docs` server of P1 serving `tools`, connected; answers the world and the server. */
const connectedDocs = async (
  t: test.TestContext,
  tools: readonly FakeTool[],
) => {
  const world = await activated(t);
  const server = await served(t, { tools });
  const created = await world.create(P1, httpServer('docs', server.url));
  await world.watchUntil(P1, inState(created.id, 'connected'), 'connected');
  await eventually(
    () => world.liveNames(P1).length === tools.length,
    'the tools registered',
    () => world.registrations,
  );

  return { world, server, id: created.id };
};

const imageTool = (data: string): FakeTool => ({
  tool: {
    name: 'snap',
    description: 'Takes a picture.',
    inputSchema: { type: 'object', properties: {} },
  },
  call: () => ({
    content: [
      { type: 'text', text: 'Here:' },
      { type: 'image', data, mimeType: 'image/png' },
    ],
  }),
});

const liveRegistration = (world: RouterWorld, name: string) =>
  world.registrations.find(
    (entry) => entry.name === name && !entry.unregistered,
  );

void test('T1: a connected tool is registered for the Project at order 1000, not always available, and Execute calls it by its MCP name with the arguments and answers its text', async (t) => {
  const { world, server } = await connectedDocs(t, [
    textTool('get_weather_now', {
      type: 'object',
      properties: { city: { type: 'string' } },
    }),
  ]);

  const registration = liveRegistration(world, 'mcp__docs__get_weather_now');
  assert.ok(registration !== undefined, JSON.stringify(world.registrations));
  assert.deepEqual(
    {
      projectId: registration.projectId,
      order: registration.order,
      alwaysAvailable: registration.alwaysAvailable,
    },
    { projectId: P1, order: 1000, alwaysAvailable: false },
  );

  const answer = await world.execute('mcp__docs__get_weather_now', P1, {
    city: 'Lisbon',
  });

  assert.equal(answer, 'get_weather_now: {"city":"Lisbon"}');
  assert.deepEqual(server.tools.calls, [
    { name: 'get_weather_now', arguments: { city: 'Lisbon' } },
  ]);
});

void test('T2: a result flagged isError fails Execute mcp_tool_failed with its text', async (t) => {
  const { world } = await connectedDocs(t, [
    {
      tool: {
        name: 'fail',
        description: 'Fails.',
        inputSchema: { type: 'object', properties: {} },
      },
      call: () => ({
        content: [{ type: 'text', text: 'The city is unknown.' }],
        isError: true,
      }),
    },
  ]);

  const failure = await failureOf(() =>
    world.execute('mcp__docs__fail', P1, {}),
  );

  assert.equal(failure.code, 'mcp_tool_failed');
  assert.equal(failure.message, 'The city is unknown.');
});

void test("T3: an image block is attached under the Execute call's scope as image.png with its decoded bytes, and the answer holds its reference line; an Attach refused invalid_input reads as the refusal line", async (t) => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { world } = await connectedDocs(t, [
    imageTool(bytes.toString('base64')),
  ]);

  const answer = await world.execute('mcp__docs__snap', P1, {});

  assert.equal(
    answer,
    `Here:\n\n${attachmentReference('image.png', ATTACHMENT_ID)}`,
  );
  const [attached] = world.attaches;
  assert.equal(attached?.name, 'image.png');
  assert.deepEqual(attached?.scope, {
    projectId: P1,
    threadId: THREAD,
    promptId: PROMPT,
  });
  assert.deepEqual(Buffer.from(attached?.bytes ?? []), bytes);

  world.attachError = new ContractError('invalid_input', 'Not an image.');
  const refused = await world.execute('mcp__docs__snap', P1, {});

  assert.equal(
    refused,
    'Here:\n\n[An image (image/png) the Project refused to keep.]',
  );
});

void test("T4: cancelling Execute aborts the MCP request's signal", async (t) => {
  let aborted = false;
  const { world, server } = await connectedDocs(t, [
    {
      tool: {
        name: 'slow',
        description: 'Never answers on its own.',
        inputSchema: { type: 'object', properties: {} },
      },
      call: (_args, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve({ content: [] });
            },
            { once: true },
          );
        }),
    },
  ]);
  const controller = new AbortController();

  const executing = failureOf(() =>
    world.execute('mcp__docs__slow', P1, {}, { signal: controller.signal }),
  );
  await eventually(
    () => server.tools.calls.length === 1,
    'the server received the call',
  );
  controller.abort();

  await executing;
  await eventually(() => aborted, "the MCP request's signal aborted");
});

void test('T5: tools/list_changed with a renamed tool unregisters the old one and registers the new; Execute of the old key is not_found', async (t) => {
  const { world, server } = await connectedDocs(t, [textTool('alpha')]);
  const old = liveRegistration(world, 'mcp__docs__alpha');
  assert.ok(old !== undefined);

  server.tools.setTools([textTool('beta')]);
  await server.tools.notifyToolsChanged();
  await eventually(
    () => world.liveNames(P1).join() === 'mcp__docs__beta' && old.unregistered,
    'alpha replaced by beta',
    () => world.registrations,
  );

  assert.ok(
    world
      .callsOf('tools.unregister')
      .some(({ request }) =>
        JSON.stringify(request).includes(old.registrationId),
      ),
  );
  const failure = await failureOf(() =>
    world.execute('mcp__docs__alpha', P1, {}),
  );
  assert.equal(failure.code, 'not_found');
});
