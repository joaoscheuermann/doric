import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import type { Sandbox } from 'sandbox';

import {
  createToolStorage,
  defineTool,
  type ToolCall,
  ToolDefinitionSchema,
  ToolErrorObject,
  ToolMetadataSchema,
} from '../src/index.js';

const sandbox = { id: 'sandbox', root: '/workspace' } as Sandbox;

test('exports a JSON-Schema-compatible tool definition schema', () => {
  const value = {
    name: 'lookup',
    description: 'Looks up a value.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    outputSchema: { type: 'string' },
    strict: true,
  };

  assert.deepEqual(ToolDefinitionSchema.parse(value), value);

  assert.equal(z.toJSONSchema(ToolDefinitionSchema).type, 'object');
});

test('exports strict-output-compatible tool metadata', () => {
  const value = { name: 'lookup', description: 'Looks up a value.' };

  assert.deepEqual(ToolMetadataSchema.parse(value), value);

  assert.deepEqual(z.toJSONSchema(ToolMetadataSchema).required, [
    'name',
    'description',
  ]);
});

test('infers typed payloads from Zod schemas at compile time', async () => {
  const expectString = (value: string): string => value;

  const expectNumber = (value: number): number => value;

  const factory = defineTool({
    name: 'lookup',
    input: z.object({
      query: z.string(),
      limit: z.number().optional(),
    }),
    output: z.object({
      query: z.string(),
      limit: z.number().optional(),
    }),
    execute(received, payload) {
      assert.equal(received, sandbox);

      expectString(payload.query);

      if (payload.limit !== undefined) {
        expectNumber(payload.limit);
      }

      // @ts-expect-error query is inferred as string, not number.
      expectNumber(payload.query);

      return { query: payload.query, limit: payload.limit };
    },
  });
  const tool = factory(sandbox);

  assert.deepEqual(await tool.execute({ query: 'doric' }), {
    query: 'doric',
    limit: undefined,
  });
});

test('exposes metadata before binding and binds the supplied sandbox', async () => {
  const factory = defineTool({
    name: 'search',
    description: 'Search indexed context.',
    input: z.object({ query: z.string(), limit: z.number().int().min(1) }),
    output: z.string(),
    execute: (received, { query, limit }) => {
      assert.equal(received, sandbox);

      return `${query}:${limit}`;
    },
  });

  assert.equal(factory.name, 'search');

  assert.equal(factory.description, 'Search indexed context.');

  assert.equal(factory.input instanceof z.ZodObject, true);

  assert.equal(factory.output instanceof z.ZodString, true);

  assert.equal('schema' in factory, false);

  assert.equal('outputSchema' in factory, false);

  assert.equal(factory.definition.name, 'search');

  assert.equal(factory.definition.description, 'Search indexed context.');

  assert.equal(factory.definition.strict, true);

  assert.equal(factory.definition.inputSchema.type, 'object');

  assert.deepEqual(factory.definition.inputSchema.required, ['query', 'limit']);

  assert.deepEqual(factory.definition.inputSchema.properties, {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  });

  assert.equal(factory.definition.outputSchema.type, 'string');

  assert.equal(await factory(sandbox).execute({ query: 'x', limit: 2 }), 'x:2');
});

test('allows non-strict definitions when requested', () => {
  const tool = defineTool({
    name: 'draft',
    input: z.object({ value: z.string() }),
    output: z.string(),
    strict: false,
    execute: (_sandbox, { value }) => value,
  });

  assert.equal(tool.definition.strict, false);
});

test('rejects non-object and unrepresentable schemas', () => {
  assert.throws(
    () =>
      defineTool({
        name: 'bad',
        input: z.string() as unknown as z.ZodObject,
        output: z.unknown(),
        execute: () => undefined,
      }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_schema',
  );

  assert.throws(
    () =>
      defineTool({
        name: 'bad-date',
        input: z.object({ at: z.date() }),
        output: z.unknown(),
        execute: () => undefined,
      }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_schema',
  );

  assert.throws(
    () =>
      defineTool({
        name: 'bad-output',
        input: z.object({}),
        output: z.date(),
        execute: () => new Date(),
      }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_schema',
  );
});

test('preserves definition order and rejects duplicate names', () => {
  const first = defineTool({
    name: 'first',
    input: z.object({}),
    output: z.string(),
    execute: () => 'first',
  });

  const second = defineTool({
    name: 'second',
    input: z.object({}),
    output: z.string(),
    execute: () => 'second',
  });

  assert.deepEqual(
    createToolStorage([first(sandbox), second(sandbox)])
      .definitions()
      .map((definition) => definition.name),
    ['first', 'second'],
  );

  assert.throws(
    () => createToolStorage([first(sandbox), first(sandbox)]),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'duplicate_tool',
  );
});

test('parses provider tool-call arguments into payloads', () => {
  const storage = createToolStorage([]);

  assert.deepEqual(
    storage.calls({
      toolCalls: [
        {
          id: 'call_1',
          name: 'lookup',
          arguments: '{"query":"doric"}',
          index: 0,
        },
      ],
    }),
    [{ id: 'call_1', name: 'lookup', payload: { query: 'doric' }, index: 0 }],
  );
});

test('validates payloads before execution and supports async handlers', async () => {
  const storage = createToolStorage([
    defineTool({
      name: 'add',
      input: z.object({ left: z.number(), right: z.number() }),
      output: z.number(),
      async execute(_sandbox, { left, right }) {
        return left + right;
      },
    })(sandbox),
  ]);

  assert.equal(
    await storage.execute({
      id: 'call_1',
      name: 'add',
      payload: { left: 2, right: 3 },
    }),
    5,
  );

  await assert.rejects(
    storage.execute({
      id: 'call_2',
      name: 'add',
      payload: { left: '2', right: 3 },
    } satisfies ToolCall),
    (error: unknown) =>
      error instanceof ToolErrorObject &&
      error.data.code === 'invalid_payload' &&
      error.data.issues?.[0]?.path === 'left',
  );
});

test('validates calls without executing handlers', () => {
  let executions = 0;

  const storage = createToolStorage([
    defineTool({
      name: 'lookup',
      input: z.object({ query: z.string() }),
      output: z.string(),
      execute(_sandbox, { query }) {
        executions += 1;

        return query;
      },
    })(sandbox),
  ]);

  assert.deepEqual(
    storage.validate({
      id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"doric"}',
    }),
    {
      id: 'call_1',
      name: 'lookup',
      payload: { query: 'doric' },
      index: undefined,
    },
  );

  assert.equal(executions, 0);
});

test('throws typed errors for unknown tools invalid JSON and handler failures', async () => {
  const storage = createToolStorage([
    defineTool({
      name: 'explode',
      input: z.object({ value: z.string() }),
      output: z.string(),
      execute() {
        throw new Error('boom');
      },
    })(sandbox),
  ]);

  await assert.rejects(
    storage.execute({
      id: 'call_1',
      name: 'missing',
      arguments: '{}',
    }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'unknown_tool',
  );

  await assert.rejects(
    storage.execute({
      id: 'call_2',
      name: 'explode',
      arguments: '{',
    }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_json',
  );

  await assert.rejects(
    storage.execute({
      id: 'call_3',
      name: 'explode',
      arguments: '{"value":"x"}',
    }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'handler_failed',
  );
});

test('validates handler output without exposing the rejected value', async () => {
  const tool = defineTool({
    name: 'lookup',
    input: z.object({ query: z.string() }),
    output: z.object({ results: z.array(z.string()) }).strict(),
    execute: () => ({ results: [42] }) as unknown as { results: string[] },
  })(sandbox);

  await assert.rejects(tool.execute({ query: 'doric' }), (error: unknown) => {
    assert.ok(error instanceof ToolErrorObject);

    assert.deepEqual(error.data, {
      code: 'invalid_output',
      message: 'Tool handler returned invalid output: lookup',
      toolName: 'lookup',
      issues: [
        {
          path: 'results.0',
          message: 'Invalid input: expected string, received number',
        },
      ],
    });

    assert.equal(error.cause, undefined);

    return true;
  });
});
