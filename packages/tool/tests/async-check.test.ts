import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';
import { z } from 'zod';

import {
  createToolStorage,
  defineTool,
  type Tool,
  ToolErrorObject,
  type ToolPayloadCheck,
} from '../src/index.js';

const harness = createTestServices({ bundle: { id: 'async-check-test' } });
const call = harness.call({ projectId: 'p', threadId: 't', promptId: 'q' });

/**
 * A tool whose exact schema lives elsewhere (another process): its `input` is a
 * permissive placeholder and only the asynchronous `check` validates.
 */
const remoteTool = (options: {
  readonly name: string;
  readonly execute: (payload: unknown) => Promise<unknown>;
  readonly checks?: unknown[];
}): Tool => {
  const exact = z.object({ query: z.string().transform((v) => v.trim()) });

  return {
    name: options.name,
    input: z.looseObject({}),
    output: z.unknown(),
    definition: {
      name: options.name,
      inputSchema: { type: 'object' },
      outputSchema: {},
      strict: true,
    },
    execute: (payload) => options.execute(payload),
    check: async (payload): Promise<ToolPayloadCheck> => {
      options.checks?.push(payload);
      await Promise.resolve();
      const parsed = exact.safeParse(payload);

      return parsed.success
        ? { success: true, data: parsed.data }
        : {
            success: false,
            issues: [{ path: 'query', message: 'remote: expected string' }],
          };
    },
  };
};

void test('an asynchronously checked tool validates a call to the parsed call', async () => {
  let executions = 0;
  const storage = createToolStorage([
    remoteTool({
      name: 'remote',
      execute: async () => {
        executions += 1;

        return 'never';
      },
    }),
  ]);

  const validated = storage.validate({
    id: 'call_1',
    name: 'remote',
    arguments: '{"query":" doric "}',
  });

  assert.ok(validated instanceof Promise);

  assert.deepEqual(await validated, {
    id: 'call_1',
    name: 'remote',
    payload: { query: ' doric ' },
    index: undefined,
  });

  assert.equal(executions, 0);
});

void test('an asynchronously checked tool rejects with the issues its check reports', async () => {
  const storage = createToolStorage([
    remoteTool({ name: 'remote', execute: async () => 'never' }),
  ]);

  for (const run of [storage.validate, storage.execute]) {
    await assert.rejects(
      Promise.resolve().then(() =>
        run({ id: 'call_2', name: 'remote', payload: { query: 42 } }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ToolErrorObject);

        assert.deepEqual(error.data, {
          code: 'invalid_payload',
          toolName: 'remote',
          callId: 'call_2',
          message: 'Tool call payload failed validation: remote',
          issues: [{ path: 'query', message: 'remote: expected string' }],
        });

        return true;
      },
    );
  }
});

void test('execute checks an asynchronous tool once and runs it with the checked data', async () => {
  const checks: unknown[] = [];
  const received: unknown[] = [];
  const storage = createToolStorage([
    remoteTool({
      name: 'remote',
      checks,
      execute: async (payload) => {
        received.push(payload);

        return 'ok';
      },
    }),
  ]);

  assert.equal(
    await storage.execute({
      id: 'call_3',
      name: 'remote',
      arguments: '{"query":" doric "}',
    }),
    'ok',
  );

  assert.equal(checks.length, 1);

  assert.deepEqual(received, [{ query: 'doric' }]);
});

void test('an asynchronous tool keeps invalid_output unwrapped and wraps other failures', async () => {
  const invalidOutput = new ToolErrorObject({
    code: 'invalid_output',
    toolName: 'remote',
    message: 'Tool handler returned invalid output: remote',
  });
  const boom = new Error('boom');
  const storage = createToolStorage([
    remoteTool({
      name: 'remote',
      execute: async () => {
        throw invalidOutput;
      },
    }),
    remoteTool({
      name: 'failing',
      execute: async () => {
        throw boom;
      },
    }),
  ]);

  await assert.rejects(
    storage.execute({ id: 'c', name: 'remote', payload: { query: 'x' } }),
    (error: unknown) => error === invalidOutput,
  );

  await assert.rejects(
    storage.execute({ id: 'd', name: 'failing', payload: { query: 'x' } }),
    (error: unknown) =>
      error instanceof ToolErrorObject &&
      error.data.code === 'handler_failed' &&
      error.cause === boom,
  );
});

void test('a bound tool checks payloads synchronously with its own schema', () => {
  const bound = defineTool({
    name: 'lookup',
    input: z.object({ query: z.string() }),
    output: z.string(),
    execute: ({ query }) => query,
  }).bind(harness.services);

  assert.deepEqual(bound.check({ query: 'doric' }), {
    success: true,
    data: { query: 'doric' },
  });

  assert.deepEqual(bound.toTool(call).check?.({ query: 1 }), {
    success: false,
    issues: [
      {
        path: 'query',
        message: 'Invalid input: expected string, received number',
      },
    ],
  });

  const storage = createToolStorage([bound.toTool(call)]);

  assert.throws(
    () => storage.validate({ id: 'e', name: 'lookup', payload: { query: 1 } }),
    (error: unknown) =>
      error instanceof ToolErrorObject && error.data.code === 'invalid_payload',
  );
});
