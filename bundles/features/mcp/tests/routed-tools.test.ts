// Adapter tests of S59b (D2, D3): `routedTools`, an MCP tool served from the
// SDK's `ToolHandlerService` table and registered with `tools/v1` as
// `mcpToolDefinition` bound to `routedAttach` (`alwaysAvailable: false`,
// `order: 1000`, the Project's key), its registration ended by `dispose()`
// (fired, a failure logged at `warn`), and `listed`, the names
// `tools/v1.List` gives a call scoped to the Project; and `routedAttach`,
// which keeps a tool result's image for the `Execute` call's Thread:
// `head{name}`, then the decoded bytes in chunks of at most 1 MiB. Both
// registration and listing run outside the caller's call.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { ContractError } from 'bundle/contracts';
import { attachmentReference } from 'runtime/contracts';
import { ToolErrorObject } from 'tool';

import type { McpToolSource } from '../src/host/ports.js';
import { routedAttach, routedTools } from '../src/host/routed.js';
import type { CallMcpTool } from '../src/host/tools.js';
import {
  adapterWorld,
  contractErrorFrom,
  MIB,
  P1,
  P2,
  THREAD,
} from './support/adapters.js';
import { eventually } from './support/wait.js';

const weather: Tool = {
  name: 'get.weather/now',
  description: 'Reads the weather now.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
  },
};

const NAME = 'mcp__docs__get_weather_now';
const ATTACHMENT_ID = `sha256-${'a'.repeat(64)}`;

const sourceOf = (
  answer: CallToolResult = { content: [{ type: 'text', text: 'Sunny.' }] },
  tool: Tool = weather,
) => {
  const requests: Parameters<CallMcpTool>[0][] = [];
  const source: McpToolSource = {
    name: NAME,
    tool,
    callTool: async (request) => {
      requests.push(request);

      return answer;
    },
  };

  return { source, requests };
};

const setup = async (t: test.TestContext) => {
  const world = adapterWorld();
  t.after(() => world.stop());
  const context = await world.context();

  return {
    world,
    context,
    tools: routedTools(context, world.handlers),
    attach: routedAttach(context.services),
  };
};

interface RegisterJson {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    readonly definition: {
      readonly name: string;
      readonly inputSchema: string;
      readonly strict?: boolean;
    };
  };
  readonly options: {
    readonly alwaysAvailable?: boolean;
    readonly order?: number;
    readonly projectId?: string;
  };
}

void test("routedTools: register sends tools/v1.Register with the Doric name, the server's schema verbatim, alwaysAvailable false, order 1000 and the Project", async (t) => {
  const { world, tools } = await setup(t);

  await tools.register(sourceOf().source, P1);

  assert.equal(world.registers.length, 1);
  const { tool, options } = world.registers[0] as unknown as RegisterJson;
  assert.equal(tool.name, NAME);
  assert.equal(tool.description, 'Reads the weather now.');
  assert.deepEqual(
    JSON.parse(tool.definition.inputSchema),
    weather.inputSchema,
  );
  assert.equal(tool.definition.strict, false);
  assert.equal(options.alwaysAvailable ?? false, false);
  assert.equal(options.order, 1000);
  assert.equal(options.projectId, P1);
});

void test('routedTools: Execute{name, projectId, payload} calls the MCP tool by its own name with the payload, and answers its text', async (t) => {
  const { world, tools } = await setup(t);
  const { source, requests } = sourceOf();
  await tools.register(source, P1);

  const answer = await world.execute(NAME, P1, { city: 'Lisbon' });

  assert.equal(answer, 'Sunny.');
  assert.deepEqual(requests, [
    { name: 'get.weather/now', arguments: { city: 'Lisbon' } },
  ]);
});

void test("routedTools: a tool is served only under its Project's key", async (t) => {
  const { world, tools } = await setup(t);
  await tools.register(sourceOf().source, P1);

  await assert.rejects(world.execute(NAME, P2, {}), (error: unknown) => {
    assert.equal(contractErrorFrom(error).code, 'not_found');
    return true;
  });
});

void test('routedTools: a result flagged isError fails Execute mcp_tool_failed with its text', async (t) => {
  const { world, tools } = await setup(t);
  await tools.register(
    sourceOf({
      content: [{ type: 'text', text: 'No such city.' }],
      isError: true,
    }).source,
    P1,
  );

  await assert.rejects(world.execute(NAME, P1, {}), (error: unknown) => {
    const failure = contractErrorFrom(error);
    assert.equal(failure.code, 'mcp_tool_failed');
    assert.equal(failure.message, 'No such city.');
    return true;
  });
});

void test('routedTools: an input schema that is not an object schema rejects ToolErrorObject invalid_schema and registers nothing', async (t) => {
  const { world, tools } = await setup(t);

  await assert.rejects(
    tools.register(
      sourceOf(undefined, {
        name: 'broken',
        inputSchema: { type: 'string' } as unknown as Tool['inputSchema'],
      }).source,
      P1,
    ),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_schema',
  );
  assert.deepEqual(world.registers, []);
});

void test("routedTools: the registry's refusal rejects register with its code", async (t) => {
  const { world, tools } = await setup(t);
  world.failures.set(
    'tools.register',
    new ContractError('duplicate_tool', 'Another bundle has that tool.'),
  );

  await assert.rejects(
    tools.register(sourceOf().source, P1),
    (error: unknown) => {
      assert.equal(contractErrorFrom(error).code, 'duplicate_tool');
      return true;
    },
  );
});

void test('routedTools: dispose stops serving the tool and sends tools/v1.Unregister', async (t) => {
  const { world, tools } = await setup(t);
  const registration = await tools.register(sourceOf().source, P1);

  registration.dispose();

  await eventually(() => world.unregisters.length === 1, 'the Unregister');
  await assert.rejects(world.execute(NAME, P1, {}), (error: unknown) => {
    assert.equal(contractErrorFrom(error).code, 'not_found');
    return true;
  });
});

void test('routedTools: an Unregister failure is logged at warn, never thrown', async (t) => {
  const { world, tools } = await setup(t);
  const registration = await tools.register(sourceOf().source, P1);
  world.failures.set(
    'tools.unregister',
    new ContractError('internal', 'The registry is gone.'),
  );

  assert.doesNotThrow(() => registration.dispose());

  await eventually(
    () => world.router.logs.some(({ level }) => level === 'warn'),
    'a warn log',
    () => world.router.logs,
  );
});

void test('routedTools: listed answers the names tools/v1.List gives a call scoped to the Project', async (t) => {
  const { world, tools } = await setup(t);
  const definition = (name: string) => ({
    name,
    definition: { name, inputSchema: '{}', outputSchema: '{}' },
  });
  world.listed = [
    { bundleId: 'mcp', projectId: P1, tool: definition(NAME) },
    { bundleId: 'core', tool: definition('read_file') },
  ];

  const names = await tools.listed(P1);

  assert.deepEqual([...names].sort(), [NAME, 'read_file'].sort());
  assert.deepEqual(world.callsOf('tools.list')[0]?.scope, { projectId: P1 });
});

void test("routedTools (D2): register and listed from a handler's call carry no deadline", async (t) => {
  const { world, tools } = await setup(t);

  await world.within(
    async () => {
      await tools.register(sourceOf().source, P1);
      await tools.listed(P1);
    },
    { scope: { projectId: P1, threadId: THREAD }, timeoutMs: 30_000 },
  );

  const [register] = world.callsOf('tools.register');
  const [list] = world.callsOf('tools.list');
  assert.equal(register?.deadline, 0);
  assert.equal(list?.deadline, 0);
  assert.deepEqual(list?.scope, { projectId: P1 });
});

void test("routedTools + routedAttach: an image block is attached under the Execute call's scope as image.png, and the answer holds its reference line", async (t) => {
  const { world, tools } = await setup(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await tools.register(
    sourceOf({
      content: [
        { type: 'text', text: 'Here:' },
        {
          type: 'image',
          data: bytes.toString('base64'),
          mimeType: 'image/png',
        },
      ],
    }).source,
    P1,
  );

  const answer = await world.execute(NAME, P1, {});

  assert.equal(
    answer,
    `Here:\n\n${attachmentReference('image.png', ATTACHMENT_ID)}`,
  );
  const [attached] = world.attaches;
  assert.equal(attached?.name, 'image.png');
  assert.deepEqual(attached?.scope, { projectId: P1, threadId: THREAD });
  assert.deepEqual(Buffer.concat(attached?.chunks ?? []), bytes);
});

void test('routedTools + routedAttach: an image Attach refuses invalid_input reads as the refusal line', async (t) => {
  const { world, tools } = await setup(t);
  world.attachError = new ContractError('invalid_input', 'Not an image.');
  await tools.register(
    sourceOf({
      content: [
        {
          type: 'image',
          data: Buffer.from('nope').toString('base64'),
          mimeType: 'image/png',
        },
      ],
    }).source,
    P1,
  );

  const answer = await world.execute(NAME, P1, {});

  assert.equal(answer, '[An image (image/png) the Project refused to keep.]');
});

void test("routedAttach: head{name}, then the decoded bytes in chunks of at most 1 MiB, in the current call's scope; answers the attachment", async (t) => {
  const { world, attach } = await setup(t);
  const bytes = Buffer.from(
    Uint8Array.from(
      { length: Math.floor(2.5 * MIB) },
      (_, index) => index % 251,
    ),
  );
  const scope = { projectId: P1, threadId: THREAD };

  const attachment = await world.within(
    (call) =>
      attach({ name: 'image.png', bytes: bytes.toString('base64') }, call),
    { scope },
  );

  assert.deepEqual(attachment, {
    id: ATTACHMENT_ID,
    name: 'image.png',
    mediaType: 'image/png',
    size: bytes.length,
  });
  const [attached] = world.attaches;
  assert.equal(attached?.name, 'image.png');
  assert.deepEqual(attached?.scope, scope);
  assert.deepEqual(
    attached?.chunks.map((chunk) => chunk.length),
    [MIB, MIB, bytes.length - 2 * MIB],
  );
  assert.deepEqual(Buffer.concat(attached?.chunks ?? []), bytes);
});

void test('routedAttach: bytes that are not base64 reject invalid_input and call nothing', async (t) => {
  const { world, attach } = await setup(t);

  await assert.rejects(
    world.within(
      (call) =>
        attach({ name: 'image.png', bytes: '*** not base64 ***' }, call),
      {
        scope: { projectId: P1, threadId: THREAD },
      },
    ),
    (error: unknown) => {
      assert.equal(contractErrorFrom(error).code, 'invalid_input');
      return true;
    },
  );
  assert.deepEqual(world.callsOf('attachments.attach'), []);
});

void test("routedAttach: the provider's refusal rejects with its code", async (t) => {
  const { world, attach } = await setup(t);
  world.attachError = new ContractError('invalid_input', 'Not an image.');

  await assert.rejects(
    world.within(
      (call) =>
        attach(
          { name: 'image.png', bytes: Buffer.from('x').toString('base64') },
          call,
        ),
      { scope: { projectId: P1, threadId: THREAD } },
    ),
    (error: unknown) => {
      assert.equal(contractErrorFrom(error).code, 'invalid_input');
      return true;
    },
  );
});
