// The pure pieces that turn MCP tools into Doric tools: server slugs, tool
// names and result formatting. The tool definition is `mcpToolDefinition`'s
// (`tool-execution.test.ts`); the kernel's `toDoricTool` left with the kernel
// entry (S68c).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type AttachInput,
  type Attachment,
  attachmentReference,
} from 'runtime/contracts';

import { serverSlug } from '../src/contracts/index.js';
import { formatResult, toolName, toolNamePattern } from '../src/host/tools.js';

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
