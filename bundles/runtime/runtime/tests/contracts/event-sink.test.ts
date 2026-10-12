import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defineMethod,
  defineService,
  type EventSinkSpec,
  EventsV1,
  eventsMethods,
  hooksMethods,
  storageMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { threadEventSink } from '../../src/contracts/events.js';
import {
  threadEventEnvelopeSchema,
  threadEventsStream,
} from '../../src/contracts/storage.js';
import { activate } from '../../src/host/index.js';

// M5: the runtime owns the Thread logs. Its events reach them through the
// sink it registers with events/v1, and the stored envelope keeps its shape.

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

void test('activation registers the runtime sink with events/v1 and releases it on cleanup', async () => {
  const sinks: EventSinkSpec[] = [];
  let disposed = 0;
  const events = defineService(EventsV1, {
    register: defineMethod({
      ...eventsMethods.register,
      execute: () => ({ dispose: () => undefined }),
    }),
    sink: defineMethod({
      ...eventsMethods.sink,
      execute: (spec) => {
        sinks.push(spec);

        return {
          dispose: () => {
            disposed += 1;
          },
        };
      },
    }),
    append: defineMethod({
      ...eventsMethods.append,
      execute: async () => undefined,
    }),
  });
  // Activation reads only defineType and define; the other methods the
  // contract requires are present and refuse to run.
  const unused = async (): Promise<never> => {
    throw new Error('not used by activation');
  };
  const disposable = () => ({ dispose: () => undefined });
  const storage = defineService('storage/v1', {
    defineType: defineMethod({
      ...storageMethods.defineType,
      execute: disposable,
    }),
    get: defineMethod({ ...storageMethods.get, execute: unused }),
    query: defineMethod({ ...storageMethods.query, execute: unused }),
    read: defineMethod({ ...storageMethods.read, execute: unused }),
    commit: defineMethod({ ...storageMethods.commit, execute: unused }),
    health: defineMethod({ ...storageMethods.health, execute: unused }),
  });
  const hooks = defineService('hooks/v1', {
    define: defineMethod({ ...hooksMethods.define, execute: disposable }),
    register: defineMethod({ ...hooksMethods.register, execute: disposable }),
    whenDefined: defineMethod({
      ...hooksMethods.whenDefined,
      execute: disposable,
    }),
    execute: defineMethod({ ...hooksMethods.execute, execute: unused }),
  });
  const { services } = createTestServices({
    bundle: { id: 'runtime' },
    provide: [events, storage, hooks],
  });

  const cleanup = activate({ services });

  assert.deepEqual(sinks, [threadEventSink]);
  assert.equal(disposed, 0);

  await cleanup();

  assert.equal(disposed, 1);
});
