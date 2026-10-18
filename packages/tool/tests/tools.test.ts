import assert from 'node:assert/strict';
import test from 'node:test';

import { bindRegistrant } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { z } from 'zod';

import {
  createToolStorage,
  defineTool,
  isBoundTool,
  type ToolCall,
  type ToolDefinitionObject,
  ToolDefinitionSchema,
  ToolErrorObject,
  type ToolInput,
  ToolMetadataSchema,
  type ToolOutput,
} from '../src/index.js';

const harness = createTestServices({ bundle: { id: 'tools-test' } });
const { services } = harness;
const call = harness.call({ projectId: 'p', threadId: 't', promptId: 'q' });

/** The agent-loop tool of a definition bound to the test bundle's services. */
const toolOf = <I extends ToolInput, O extends ToolOutput>(
  definition: ToolDefinitionObject<I, O>,
) => definition.bind(services).toTool(call);

void test('exports a JSON-Schema-compatible tool definition schema', () => {
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

void test('exports strict-output-compatible tool metadata', () => {
  const value = { name: 'lookup', description: 'Looks up a value.' };

  assert.deepEqual(ToolMetadataSchema.parse(value), value);

  assert.deepEqual(z.toJSONSchema(ToolMetadataSchema).required, [
    'name',
    'description',
  ]);
});

void test('infers typed payloads from Zod schemas at compile time', async () => {
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
    execute(payload, received, bound) {
      assert.equal(received, call);

      assert.equal(bound, services);

      expectString(payload.query);

      if (payload.limit !== undefined) {
        expectNumber(payload.limit);
      }

      // @ts-expect-error query is inferred as string, not number.
      expectNumber(payload.query);

      return { query: payload.query, limit: payload.limit };
    },
  });
  const tool = toolOf(factory);

  assert.deepEqual(await tool.execute({ query: 'doric' }), {
    query: 'doric',
    limit: undefined,
  });
});

void test('exposes metadata before binding and binds the registrant services', async () => {
  const factory = defineTool({
    name: 'search',
    description: 'Search indexed context.',
    input: z.object({ query: z.string(), limit: z.number().int().min(1) }),
    output: z.string(),
    execute: ({ query, limit }, received, bound) => {
      assert.equal(received, call);

      assert.equal(bound, services);

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

  assert.deepEqual(factory.settings, []);

  assert.equal(await toolOf(factory).execute({ query: 'x', limit: 2 }), 'x:2');

  const bound = factory[bindRegistrant](services);

  assert.equal(isBoundTool(bound), true);

  assert.equal(isBoundTool(factory), false);

  assert.equal(bound.definition, factory.definition);

  assert.equal(await bound.execute({ query: 'y', limit: 3 }, call), 'y:3');
});

void test('allows non-strict definitions when requested', () => {
  const tool = defineTool({
    name: 'draft',
    input: z.object({ value: z.string() }),
    output: z.string(),
    strict: false,
    execute: ({ value }) => value,
  });

  assert.equal(tool.definition.strict, false);
});

void test('rejects non-object and unrepresentable schemas', () => {
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

void test('preserves definition order and rejects duplicate names', () => {
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
    createToolStorage([toolOf(first), toolOf(second)])
      .definitions()
      .map((definition) => definition.name),
    ['first', 'second'],
  );

  assert.throws(
    () => createToolStorage([toolOf(first), toolOf(first)]),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'duplicate_tool',
  );
});

void test('parses provider tool-call arguments into payloads', () => {
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

void test('validates payloads before execution and supports async handlers', async () => {
  const storage = createToolStorage([
    toolOf(
      defineTool({
        name: 'add',
        input: z.object({ left: z.number(), right: z.number() }),
        output: z.number(),
        async execute({ left, right }) {
          return left + right;
        },
      }),
    ),
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

void test('validates calls without executing handlers', () => {
  let executions = 0;

  const storage = createToolStorage([
    toolOf(
      defineTool({
        name: 'lookup',
        input: z.object({ query: z.string() }),
        output: z.string(),
        execute({ query }) {
          executions += 1;

          return query;
        },
      }),
    ),
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

void test('throws typed errors for unknown tools invalid JSON and handler failures', async () => {
  const storage = createToolStorage([
    toolOf(
      defineTool({
        name: 'explode',
        input: z.object({ value: z.string() }),
        output: z.string(),
        execute() {
          throw new Error('boom');
        },
      }),
    ),
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

void test('validates handler output without exposing the rejected value', async () => {
  const tool = toolOf(
    defineTool({
      name: 'lookup',
      input: z.object({ query: z.string() }),
      output: z.object({ results: z.array(z.string()) }).strict(),
      execute: () => ({ results: [42] }) as unknown as { results: string[] },
    }),
  );

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
