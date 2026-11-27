import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type RestError,
  restContractError,
  restErrors,
} from 'runtime/contracts';

/*
 * R-ERR (stage 9 WP-H): the REST error table of `runtime/contracts` that the
 * route bodies answer by. Its outcome-by-outcome comparison with the routes
 * left with the kernel routes (S69); the RPCs state it in
 * `router-projects.test.ts` and `router-threads.test.ts` (P1).
 */

const id = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';

void test('the Thread execution refusals carry their own messages', () => {
  assert.deepEqual(
    restErrors.setThreadExecution({ status: 'missing' }),
    restErrors.thread(undefined),
  );
  for (const [reason, message] of [
    ['provider', 'The provider is not configured.'],
    ['model', 'The model is not available on this provider.'],
    ['effort', 'This model does not support that effort.'],
  ] as const) {
    const error = restErrors.setThreadExecution({ status: 'invalid', reason });
    assert.equal(error?.status, 422);
    assert.equal(error?.code, 'invalid_execution');
    assert.equal(error?.message, message);
  }
  const unresolvable = restErrors.setThreadExecution({
    status: 'unresolvable',
    message: 'The provider has no credential.',
  });
  assert.equal(unresolvable?.status, 422);
  assert.equal(unresolvable?.code, 'invalid_execution');
  assert.equal(unresolvable?.message, 'The provider has no credential.');
});

void test('a success outcome is no error', () => {
  assert.equal(restErrors.deleteProject('deleted'), undefined);
  assert.equal(restErrors.prompt({ status: 'accepted', promptId }), undefined);
  assert.equal(restErrors.steer({ status: 'steered', promptId }), undefined);
  assert.equal(restErrors.steer({ status: 'queued', promptId }), undefined);
  assert.equal(restErrors.pause('interrupted'), undefined);
  assert.equal(restErrors.removeQueued('removed'), undefined);
  assert.equal(restErrors.terminalWrite(true), undefined);
  assert.equal(restErrors.thread({}), undefined);
});

void test('an updated execution is no error', () => {
  assert.equal(
    restErrors.setThreadExecution({
      status: 'updated',
      thread: {
        id,
        projectId: id,
        name: 'Thread',
        state: 'ready',
        lastSequence: 0,
        cwd: '/workspace',
        createdAt: '',
        updatedAt: '',
      },
    }),
    undefined,
  );
});

void test('the adapter error keeps the code, the message and the status', () => {
  const error = restContractError(
    restErrors.deleteProject('active') as RestError,
  );
  assert.equal(error.name, 'ContractError');
  assert.equal(error.code, 'project_active');
  assert.equal(error.message, 'The project cannot perform this operation.');
  assert.deepEqual(error.details, { status: 409 });
});
