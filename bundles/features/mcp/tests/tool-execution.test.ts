// S59a: one execute body for an MCP tool (`executeMcpTool`), shared by the
// kernel's `toDoricTool` and the process's `mcpToolDefinition`, which binds
// it to an `attach` port instead of the kernel's services.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { type Call, ContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type AttachInput,
  type Attachment,
  attachmentReference,
} from 'runtime/contracts';
import { ToolErrorObject } from 'tool';

import type { McpToolSource } from '../src/host/ports.js';
import {
  type CallMcpTool,
  executeMcpTool,
  mcpToolDefinition,
} from '../src/host/tools.js';
import { codeOf } from './support/wait.js';
import { P1 } from './support/world.js';

const weather: Tool = {
  name: 'get.weather/now',
  title: 'Current weather',
  description: 'Reads the weather now.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

const NAME = 'mcp__docs__get_weather_now';

/** A source whose server answers `result` and records each request. */
const sourceOf = (
  result: CallToolResult | (() => Promise<CallToolResult>),
  tool: Tool = weather,
) => {
  const requests: Parameters<CallMcpTool>[] = [];
  const source: McpToolSource = {
    name: NAME,
    tool,
    callTool: (request, signal) => {
      requests.push([request, signal]);

      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };

  return { source, requests };
};

/** An `attach` port that records each call and answers an attachment. */
const attaching = (fail?: unknown) => {
  const calls: { input: AttachInput; call: Call }[] = [];
  const attach = (input: AttachInput, call: Call): Promise<Attachment> => {
    calls.push({ input, call });

    if (fail !== undefined) {
      return Promise.reject(fail);
    }

    return Promise.resolve({
      id: 'sha256-abc',
      name: input.name,
      mediaType: 'image/png',
      size: 3,
    });
  };

  return { calls, attach };
};

const promptCall = (signal?: AbortSignal) => {
  const world = createTestServices({ bundle: { id: 'mcp' } });
  const call = world.call(
    { projectId: P1, threadId: 'thread-1', promptId: 'prompt-1' },
    signal,
  );

  return { world, call };
};

const PNG = Buffer.from('png').toString('base64');

void test('S59a E1 executeMcpTool calls the server tool by its MCP name with the arguments and the call signal, and answers its text', async (t) => {
  const { source, requests } = sourceOf({
    content: [{ type: 'text', text: 'Sunny.' }],
  });
  const controller = new AbortController();
  const { world, call } = promptCall(controller.signal);
  t.after(() => world.dispose());

  const text = await executeMcpTool(
    source,
    { city: 'Lisbon' },
    call,
    attaching().attach,
  );

  assert.equal(text, 'Sunny.');

  assert.deepEqual(requests[0]?.[0], {
    name: 'get.weather/now',
    arguments: { city: 'Lisbon' },
  });

  controller.abort();

  assert.equal(requests[0]?.[1].aborted, true);
});

void test('S59a E2 executeMcpTool rejects a result flagged isError with mcp_tool_failed and its text, or a default text when empty', async (t) => {
  const { world, call } = promptCall();
  t.after(() => world.dispose());

  await assert.rejects(
    executeMcpTool(
      sourceOf({
        content: [{ type: 'text', text: 'City not found.' }],
        isError: true,
      }).source,
      { city: 'Atlantis' },
      call,
      attaching().attach,
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'mcp_tool_failed');
      assert.equal((error as Error).message, 'City not found.');
      return true;
    },
  );

  await assert.rejects(
    executeMcpTool(
      sourceOf({ content: [], isError: true }).source,
      { city: 'Atlantis' },
      call,
      attaching().attach,
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'mcp_tool_failed');
      assert.equal(
        (error as Error).message,
        'The MCP tool get.weather/now failed.',
      );
      return true;
    },
  );
});

void test('S59a E3 executeMcpTool keeps an image through attach under the same call and answers its reference line', async (t) => {
  const { world, call } = promptCall();
  t.after(() => world.dispose());
  const attach = attaching();

  const text = await executeMcpTool(
    sourceOf({
      content: [
        { type: 'text', text: 'Here:' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
    }).source,
    { city: 'Lisbon' },
    call,
    attach.attach,
  );

  assert.equal(attach.calls.length, 1);

  assert.deepEqual(attach.calls[0]?.input, { name: 'image.png', bytes: PNG });

  assert.equal(attach.calls[0]?.call, call);

  assert.equal(
    text,
    `Here:\n\n${attachmentReference('image.png', 'sha256-abc')}`,
  );
});

void test('S59a E4 executeMcpTool reads an image attach refuses (invalid_input) as one line, and rejects with any other attach failure', async (t) => {
  const { world, call } = promptCall();
  t.after(() => world.dispose());
  const result: CallToolResult = {
    content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
  };

  assert.equal(
    await executeMcpTool(
      sourceOf(result).source,
      {},
      call,
      attaching(new ContractError('invalid_input', 'Too large.')).attach,
    ),
    '[An image (image/png) the Project refused to keep.]',
  );

  await assert.rejects(
    executeMcpTool(
      sourceOf(result).source,
      {},
      call,
      attaching(new ContractError('unavailable', 'No attachments.')).attach,
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'unavailable');
      return true;
    },
  );
});

void test('S59a E5 executeMcpTool rejects with the server call failure', async (t) => {
  const { world, call } = promptCall();
  t.after(() => world.dispose());
  const failure = new Error('The connection closed.');

  await assert.rejects(
    executeMcpTool(
      sourceOf(() => Promise.reject(failure)).source,
      {},
      call,
      attaching().attach,
    ),
    (error: unknown) => error === failure,
  );
});

void test('S59a D1 mcpToolDefinition keeps the name, the description (else the title), the input schema verbatim, and is not strict', () => {
  const definition = mcpToolDefinition(sourceOf({ content: [] }).source);

  assert.equal(definition.name, NAME);

  assert.equal(definition.description, 'Reads the weather now.');

  assert.deepEqual(definition.definition.inputSchema, weather.inputSchema);

  assert.equal(definition.definition.strict, false);

  const { description: _description, ...untitled } = weather;

  assert.equal(
    mcpToolDefinition(sourceOf({ content: [] }, untitled).source).description,
    'Current weather',
  );
});

void test('S59a D2 mcpToolDefinition bound to an attach port executes through the server and attaches under the execute call', async (t) => {
  const { world, call } = promptCall();
  t.after(() => world.dispose());
  const { source, requests } = sourceOf({
    content: [
      { type: 'text', text: 'Map:' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ],
  });
  const attach = attaching();
  const tool = mcpToolDefinition(source).bind({ attach: attach.attach });

  const text = await tool.execute({ city: 'Lisbon' }, call);

  assert.deepEqual(requests[0]?.[0], {
    name: 'get.weather/now',
    arguments: { city: 'Lisbon' },
  });

  assert.equal(attach.calls[0]?.call.scope?.threadId, 'thread-1');

  assert.equal(
    text,
    `Map:\n\n${attachmentReference('image.png', 'sha256-abc')}`,
  );
});

void test('S59a D3 mcpToolDefinition refuses an input schema that is not an object schema', () => {
  assert.throws(
    () =>
      mcpToolDefinition({
        name: 'mcp__docs__broken',
        tool: {
          name: 'broken',
          inputSchema: { type: 'string' } as unknown as Tool['inputSchema'],
        },
        callTool: async () => ({ content: [] }),
      }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_schema',
  );
});
