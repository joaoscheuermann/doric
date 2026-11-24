import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { ContractError, isContractError } from 'bundle/contracts';
import express from 'express';

import {
  CreateThreadRequestSchema,
  SetProjectColorRequestSchema,
} from '../src/contracts/gen/doric/api/projects/v1/projects_pb.js';
import {
  ListEventsRequestSchema,
  UpdateQueuedPromptRequestSchema,
} from '../src/contracts/gen/doric/api/threads/v1/threads_pb.js';
import {
  type ApiAnswer,
  answerValue,
  apiError,
  apiFailure,
  routeInputOf,
  sendAnswer,
} from '../src/host/api/answer.js';
import { projectOperations } from '../src/host/api/operations/projects.js';
import { threadOperations } from '../src/host/api/operations/threads.js';
import type { TransportPorts } from '../src/host/api/ports.js';

/*
 * S60b: the shared answer of the route bodies (contract s60 §2.4). K2's HTTP
 * half (`sendAnswer` writes today's statuses, `Retry-After: 1` for pending)
 * through a real Express server; K3 (`routeInputOf` splits a request message
 * into today's params and query/body); and the RPC half (`apiError`,
 * `apiFailure`, `answerValue`) as D3 states it.
 */

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';

const internalMessage = 'The request could not be completed.';

/** Serves each answer under `/<index>` through `sendAnswer`, as a route would. */
const answering = async (
  answers: readonly ApiAnswer<unknown>[],
): Promise<{ readonly url: string; close(): Promise<void> }> => {
  const app = express();
  app.get('/:index', (request, response) => {
    sendAnswer(response, answers[Number(request.params.index)] as never);
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

test('K2: sendAnswer writes 202 {status: pending} with Retry-After: 1 for a pending answer', async () => {
  const host = await answering([{ kind: 'pending' }]);
  try {
    const response = await fetch(`${host.url}/0`);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), { status: 'pending' });
  } finally {
    await host.close();
  }
});

test("K2: sendAnswer writes an ok answer's value with its status", async () => {
  const value = { id: projectId, name: 'Plan' };
  const host = await answering([
    { kind: 'ok', status: 200, value },
    { kind: 'ok', status: 201, value },
    { kind: 'ok', status: 202, value },
  ]);
  try {
    for (const [index, status] of [200, 201, 202].entries()) {
      const response = await fetch(`${host.url}/${index}`);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), value);
    }
  } finally {
    await host.close();
  }
});

test('K2: sendAnswer writes 204 with no body', async () => {
  const host = await answering([{ kind: 'ok', status: 204, value: undefined }]);
  try {
    const response = await fetch(`${host.url}/0`);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  } finally {
    await host.close();
  }
});

test("K2: sendAnswer writes a refusal as today's {error: {code, message}} with its status", async () => {
  const host = await answering([
    {
      kind: 'refused',
      error: {
        status: 410,
        code: 'project_files_expired',
        message: 'The Project file access has expired.',
      },
    },
  ]);
  try {
    const response = await fetch(`${host.url}/0`);
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'project_files_expired',
        message: 'The Project file access has expired.',
      },
    });
  } finally {
    await host.close();
  }
});

test("D3: apiError is a ContractError with the refusal's code and message and no details", () => {
  const error = apiError({
    status: 404,
    code: 'project_not_found',
    message: 'The project was not found.',
  });
  assert.equal(isContractError(error), true);
  assert.equal(error.code, 'project_not_found');
  assert.equal(error.message, 'The project was not found.');
  assert.equal(error.details, undefined);
});

test('D3/Q3: apiFailure passes the retryable signals through unchanged', () => {
  for (const code of [
    'unavailable',
    'generation_lost',
    'limit_exceeded',
    'deadline_exceeded',
    'cancelled',
  ]) {
    const error = apiFailure(new ContractError(code, `The ${code} case.`));
    assert.equal(error.code, code);
    assert.equal(error.message, `The ${code} case.`);
  }
});

test("D3: apiFailure answers internal_error with today's message for any other failure", () => {
  for (const failure of [
    new Error('a stack detail'),
    new ContractError('thread_busy', 'A contract refusal.'),
    'a string',
    undefined,
  ]) {
    const error = apiFailure(failure);
    assert.equal(isContractError(error), true);
    assert.equal(error.code, 'internal_error');
    assert.equal(error.message, internalMessage);
    assert.equal(error.details, undefined);
  }
});

test("answerValue answers an ok answer's value", () => {
  const value = { promptId };
  assert.equal(answerValue({ kind: 'ok', status: 202, value }), value);
});

test('answerValue throws the refusal as apiError', () => {
  assert.throws(
    () =>
      answerValue({
        kind: 'refused',
        error: {
          status: 409,
          code: 'thread_active',
          message: 'The thread cannot perform this operation.',
        },
      }),
    (error: unknown) =>
      isContractError(error) &&
      error.code === 'thread_active' &&
      error.message === 'The thread cannot perform this operation.',
  );
});

test('answerValue throws internal_error for a pending answer', () => {
  assert.throws(
    () => answerValue({ kind: 'pending' }),
    (error: unknown) =>
      isContractError(error) &&
      error.code === 'internal_error' &&
      error.message === internalMessage,
  );
});

test('K3: routeInputOf puts path fields under their Express names and the rest in query and body', () => {
  const input = routeInputOf(
    UpdateQueuedPromptRequestSchema,
    create(UpdateQueuedPromptRequestSchema, {
      threadId,
      promptId,
      text: 'Edited',
      revision: 3,
    }),
    { threadId: 'id', promptId: 'promptId' },
  );
  assert.deepEqual(input.params, { id: threadId, promptId });
  assert.deepEqual(input.body, { text: 'Edited', revision: 3 });
  assert.deepEqual(input.query, { text: 'Edited', revision: 3 });
});

test('K3: routeInputOf emits implicit fields', () => {
  const input = routeInputOf(
    UpdateQueuedPromptRequestSchema,
    create(UpdateQueuedPromptRequestSchema, { threadId, promptId }),
    { threadId: 'id', promptId: 'promptId' },
  );
  assert.deepEqual(input.body, { text: '', revision: 0 });
});

test('K3: routeInputOf leaves an absent optional field absent', () => {
  const absent = routeInputOf(
    SetProjectColorRequestSchema,
    create(SetProjectColorRequestSchema, { projectId }),
    { projectId: 'id' },
  );
  assert.deepEqual(absent.params, { id: projectId });
  assert.deepEqual(absent.body, {});
  assert.equal(Object.hasOwn(absent.body as object, 'color'), false);

  const present = routeInputOf(
    SetProjectColorRequestSchema,
    create(SetProjectColorRequestSchema, { projectId, color: 'teal' }),
    { projectId: 'id' },
  );
  assert.deepEqual(present.body, { color: 'teal' });
});

test('K3: routeInputOf gives a numeric query field as a number', () => {
  const input = routeInputOf(
    ListEventsRequestSchema,
    create(ListEventsRequestSchema, { threadId, afterSequence: 5 }),
    { threadId: 'id' },
  );
  assert.deepEqual(input.params, { id: threadId });
  assert.deepEqual(input.query, { afterSequence: 5 });
});

test("K3: a strict body schema accepts routeInputOf's body (UpdateQueuedPrompt → editQueued)", async () => {
  const calls: unknown[] = [];
  const prompt = { promptId, text: 'Edited', revision: 4 };
  const ports = {
    threads: {
      editQueued: async (input: unknown) => {
        calls.push(input);
        return { status: 'updated', prompt };
      },
    },
  } as unknown as Pick<TransportPorts, 'threads' | 'git' | 'usage'>;

  const answer = await threadOperations(ports).editQueued(
    routeInputOf(
      UpdateQueuedPromptRequestSchema,
      create(UpdateQueuedPromptRequestSchema, {
        threadId,
        promptId,
        text: 'Edited',
        revision: 3,
      }),
      { threadId: 'id', promptId: 'promptId' },
    ),
  );

  assert.deepEqual(answer, { kind: 'ok', status: 200, value: prompt });
  assert.deepEqual(calls, [
    { id: threadId, promptId, text: 'Edited', revision: 3 },
  ]);
});

test("K3: a strict body schema accepts routeInputOf's body (CreateThread → createThread)", async () => {
  const calls: unknown[] = [];
  const thread = { id: threadId, projectId, name: 'Plan' };
  const ports = {
    threads: {
      createThread: async (input: unknown) => {
        calls.push(input);
        return { status: 'created', thread };
      },
    },
  } as unknown as Pick<
    TransportPorts,
    'runtime' | 'threads' | 'lease' | 'files' | 'git' | 'resources'
  >;

  const answer = await projectOperations(ports).createThread(
    routeInputOf(
      CreateThreadRequestSchema,
      create(CreateThreadRequestSchema, { projectId, name: 'Plan' }),
      { projectId: 'id' },
    ),
  );

  assert.deepEqual(answer, { kind: 'ok', status: 201, value: thread });
  assert.deepEqual(calls, [{ projectId, name: 'Plan' }]);
});
