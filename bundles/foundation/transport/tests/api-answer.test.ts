import assert from 'node:assert/strict';
import test from 'node:test';

import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  isContractError,
  toConnectError,
} from 'bundle/contracts';

import {
  CreateThreadRequestSchema,
  SetProjectColorRequestSchema,
} from '../src/contracts/gen/doric/api/projects/v1/projects_pb.js';
import {
  ListEventsRequestSchema,
  UpdateQueuedPromptRequestSchema,
} from '../src/contracts/gen/doric/api/threads/v1/threads_pb.js';
import {
  answerValue,
  apiError,
  apiFailure,
  routeInputOf,
} from '../src/host/api/answer.js';
import { projectOperations } from '../src/host/api/operations/projects.js';
import { threadOperations } from '../src/host/api/operations/threads.js';
import type { TransportPorts } from '../src/host/api/ports.js';

/*
 * S60b: the shared answer of the route bodies (contract s60 §2.4). K3
 * (`routeInputOf` splits a request message into today's params and
 * query/body); and the RPC half (`apiError`, `apiFailure`, `answerValue`) as
 * D3 states it. K2's HTTP half (`sendAnswer`) left with the kernel routes
 * (S69).
 */

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';

const internalMessage = 'The request could not be completed.';

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

test('D3 (S60c): apiFailure reads a ConnectError as contractErrorOf does, passing the retryable codes unchanged', () => {
  for (const code of [
    'unavailable',
    'generation_lost',
    'limit_exceeded',
    'deadline_exceeded',
    'cancelled',
  ]) {
    const failure = apiFailure(
      toConnectError(new ContractError(code, `${code} happened`)),
    );

    assert.ok(isContractError(failure), code);
    assert.equal(failure.code, code);
    assert.equal(failure.message, `${code} happened`);
  }

  for (const error of [
    toConnectError(new ContractError('credential_missing', 'secret detail')),
    new ConnectError('secret detail', Code.Unknown),
  ]) {
    const failure = apiFailure(error);

    assert.equal(failure.code, 'internal_error');
    assert.equal(failure.message, 'The request could not be completed.');
  }
});
