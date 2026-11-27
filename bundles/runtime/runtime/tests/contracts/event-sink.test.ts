import assert from 'node:assert/strict';
import test from 'node:test';

import { threadEventSink } from '../../src/contracts/events.js';
import {
  threadEventEnvelopeSchema,
  threadEventsStream,
} from '../../src/contracts/storage.js';

// M5: the runtime owns the Thread logs. Its events reach them through the
// sink it registers with events/v1, and the stored envelope keeps its shape.
// The registration itself is tested on the router world
// (`tests/router/activation.test.ts` 11) since the kernel entry went (S68d).

const accepts =
  (schema: { safeParse(value: unknown): { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

void test('the runtime sink names the Thread log of its scope, keys in row order', () => {
  assert.deepEqual(threadEventSink.scopeKeys, [
    'projectId',
    'threadId',
    'promptId',
  ]);
  assert.equal(
    threadEventSink.stream.replace('{threadId}', 't1'),
    threadEventsStream('t1'),
  );
  assert.equal(threadEventsStream('t1'), 'runtime.thread.events/t1');
});

void test('a Thread log entry carries the Project, Thread and prompt, its type and body', () => {
  const envelope = {
    projectId: 'p1',
    threadId: 't1',
    promptId: 'r1',
    type: 'prompt.finished',
    event: { status: 'completed' },
  };

  assert.ok(accepts(threadEventEnvelopeSchema)(envelope));
  // createdAt is the protocol entry's, never part of the value.
  assert.equal(
    accepts(threadEventEnvelopeSchema)({
      ...envelope,
      createdAt: '2026-10-09T12:00:00.000Z',
    }),
    false,
  );
  assert.equal(
    accepts(threadEventEnvelopeSchema)({ ...envelope, promptId: undefined }),
    false,
  );
});
