// The pure pieces that turn MCP tools into Doric tools: server slugs, tool
// names, result formatting and the tool definition itself.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { createTestServices } from 'bundle/testing';
import {
  type AttachInput,
  type Attachment,
  attachmentReference,
} from 'runtime/contracts';
import { ToolErrorObject } from 'tool';

import { serverSlug } from '../src/contracts/index.js';
import {
  type CallMcpTool,
  formatResult,
  toDoricTool,
  toolName,
  toolNamePattern,
} from '../src/host/tools.js';
import { codeOf } from './support/wait.js';
import { P1 } from './support/world.js';

const sha8 = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 8);

void test('H15 serverSlug lowercases, folds each run of other characters into one _, and trims', () => {
  assert.equal(serverSlug('GitHub Copilot'), 'github_copilot');

  assert.equal(serverSlug('  My  Server! '), 'my_server');

  assert.equal(serverSlug('docs-hub_2'), 'docs-hub_2');

  const long = serverSlug('A very long server name that keeps going');

  assert.ok(long.length <= 20);

  assert.match(long, /^[a-z0-9-][a-z0-9_-]*[a-z0-9-]$/u);
});

void test('H15 a server slug never holds __, so the tool name says which server it is and two servers never share one', () => {
  const servers = ['a', 'a__b', 'a_b', 'a _b', '_a_', 'Docs  Hub', 'x-y'];
  const tools = ['x', 'b__x', '__y', '_z', 'b'];
  const names = new Map<string, string>();

  for (const server of servers) {
    const slug = serverSlug(server);

    assert.ok(!slug.includes('__'), slug);

    for (const tool of tools) {
      const name = toolName(slug, tool, new Set());

      assert.equal(name.slice(5, name.indexOf('__', 5)), slug, name);

      const other = names.get(name);

      assert.ok(other === undefined || serverSlug(other) === slug, name);
      names.set(name, server);
    }
  }

  assert.equal(serverSlug('a__b'), 'a_b');
});

void test('H15 toolName prefixes the slug and replaces characters outside [a-zA-Z0-9_-]', () => {
  assert.equal(
    toolName('docs', 'get.weather/now', new Set()),
    'mcp__docs__get_weather_now',
  );

  assert.equal(
    toolName('docs', 'Search-Docs_2', new Set()),
    'mcp__docs__Search-Docs_2',
  );
});

void test('H15 a name over 64 characters is cut and suffixed with the hash of the MCP name', () => {
  const long = 'x'.repeat(70);

  const name = toolName('docs', long, new Set());

  assert.equal(name, `${`mcp__docs__${long}`.slice(0, 55)}_${sha8(long)}`);

  assert.match(name, toolNamePattern);
});

void test('H15 a name already taken is suffixed with the hash, so two names that sanitize alike stay distinct', () => {
  const first = toolName('docs', 'a.b', new Set());
  const second = toolName('docs', 'a/b', new Set([first]));

  assert.equal(first, 'mcp__docs__a_b');

  assert.equal(second, `mcp__docs__a_b_${sha8('a/b')}`);

  assert.match(second, toolNamePattern);
});

void test('H15 every tool name matches the tools/v1 pattern', () => {
  const taken = new Set<string>();

  for (const mcpName of [
    'ok',
    'with space',
    'ünïcödé',
    '#'.repeat(80),
    'a'.repeat(64),
  ]) {
    const name = toolName(serverSlug('Some Server!'), mcpName, taken);

    assert.match(name, toolNamePattern);

    assert.ok(!taken.has(name));
    taken.add(name);
  }
});

const attachment: Attachment = {
  id: `sha256-${'a'.repeat(64)}`,
  name: 'chart.png',
  mediaType: 'image/png',
  size: 3,
};

const attaching = () => {
  const inputs: AttachInput[] = [];
  const attach = async (input: AttachInput): Promise<Attachment> => {
    inputs.push(input);
    return attachment;
  };

  return { inputs, attach };
};

const refusing = async (): Promise<Attachment> => {
  throw new Error('Not an image a model reads.');
};

void test('formatResult joins text blocks with a blank line', async () => {
  const result: CallToolResult = {
    content: [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ],
  };

  assert.equal(await formatResult(result, attaching().attach), 'one\n\ntwo');
});

void test('formatResult attaches an image and answers its reference line', async () => {
  const { inputs, attach } = attaching();

  const text = await formatResult(
    {
      content: [
        { type: 'text', text: 'Chart:' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    },
    attach,
  );

  assert.deepEqual(
    inputs.map((input) => input.bytes),
    ['AQID'],
  );

  assert.equal(
    text,
    `Chart:\n\n${attachmentReference(attachment.name, attachment.id)}`,
  );
});

void test('formatResult names a refused image, an audio clip or a blob in one line without its bytes', async () => {
  const data = 'U0VDUkVUQllURVM=';

  for (const block of [
    { type: 'image' as const, data, mimeType: 'image/x-icon' },
    { type: 'audio' as const, data, mimeType: 'audio/wav' },
    {
      type: 'resource' as const,
      resource: {
        uri: 'file:///blob.bin',
        blob: data,
        mimeType: 'application/octet-stream',
      },
    },
  ]) {
    const text = await formatResult({ content: [block] }, refusing);

    assert.ok(text.trim().length > 0);

    assert.ok(!text.includes('\n'));

    assert.ok(!text.includes(data));
  }
});

void test('formatResult writes a resource link as a Markdown link and an embedded text resource as its text', async () => {
  const text = await formatResult(
    {
      content: [
        {
          type: 'resource_link',
          uri: 'file:///docs/readme.md',
          name: 'readme.md',
        },
        {
          type: 'resource',
          resource: { uri: 'file:///notes.txt', text: 'Embedded notes.' },
        },
      ],
    },
    attaching().attach,
  );
  const [link, embedded] = text.split('\n\n');

  assert.match(link ?? '', /^\[[^\]]+\]\(file:\/\/\/docs\/readme\.md\)$/u);

  assert.equal(embedded, 'Embedded notes.');
});

void test('formatResult answers structured content as JSON when there is no content', async () => {
  const structuredContent = { temperature: 21, unit: 'C' };

  const text = await formatResult(
    { content: [], structuredContent },
    attaching().attach,
  );

  assert.deepEqual(JSON.parse(text), structuredContent);
});

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

const bound = (
  tool: Tool,
  callTool: CallMcpTool,
  name = 'mcp__docs__get_weather_now',
) => {
  const world = createTestServices({ bundle: { id: 'mcp' } });
  const definition = toDoricTool({ name, tool, callTool });

  return { definition, world, tool: definition.bind(world.services) };
};

void test('toDoricTool keeps the input schema verbatim, is not strict, and describes the tool', () => {
  const { definition, world } = bound(weather, async () => ({ content: [] }));

  assert.equal(definition.name, 'mcp__docs__get_weather_now');

  assert.deepEqual(definition.definition.inputSchema, weather.inputSchema);

  assert.equal(definition.definition.strict, false);

  assert.equal(definition.description, 'Reads the weather now.');

  const { description: _description, ...untitled } = weather;

  assert.equal(
    toDoricTool({
      name: 'mcp__docs__untitled',
      tool: untitled,
      callTool: async () => ({ content: [] }),
    }).description,
    'Current weather',
  );

  void world.dispose();
});

void test('toDoricTool executes through callTool with the MCP name, the arguments and the call signal', async () => {
  const requests: Parameters<CallMcpTool>[] = [];
  const { tool, world } = bound(weather, async (request, signal) => {
    requests.push([request, signal]);
    return { content: [{ type: 'text', text: 'Sunny.' }] };
  });
  const controller = new AbortController();

  const result = await tool.execute(
    { city: 'Lisbon' },
    world.call(
      { projectId: P1, threadId: 'thread-1', promptId: 'prompt-1' },
      controller.signal,
    ),
  );

  assert.equal(result, 'Sunny.');

  assert.deepEqual(requests[0]?.[0], {
    name: 'get.weather/now',
    arguments: { city: 'Lisbon' },
  });

  controller.abort();

  assert.equal(requests[0]?.[1].aborted, true);

  await world.dispose();
});

void test('toDoricTool rejects a result flagged isError with mcp_tool_failed and its text', async () => {
  const { tool, world } = bound(weather, async () => ({
    content: [{ type: 'text', text: 'City not found.' }],
    isError: true,
  }));

  await assert.rejects(
    tool.execute(
      { city: 'Atlantis' },
      world.call({ projectId: P1, threadId: 'thread-1', promptId: 'prompt-1' }),
    ),
    (error: unknown) => {
      assert.equal(codeOf(error), 'mcp_tool_failed');
      assert.match((error as Error).message, /City not found\./u);
      return true;
    },
  );

  await world.dispose();
});

void test('toDoricTool refuses an input schema that is not an object schema', () => {
  assert.throws(
    () =>
      toDoricTool({
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
