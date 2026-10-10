import assert from 'node:assert/strict';
import test from 'node:test';

import { defineMethod, defineService } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type * as host from 'host';
import type { SandboxExecInput } from 'sandbox';
import type { z } from 'zod';

import {
  type CwdChange,
  type InterruptResult,
  type LeaseExecInput,
  type PromptResult,
  type RuntimeThreadControls,
  RuntimeThreadsV1,
  type RuntimeWorkspace,
  runtimeThreadsMethods,
  type SpawnedThread,
  type ThreadEventsPage,
  type ThreadEventView,
  type ThreadPage,
  type ThreadResult,
  type ThreadSummary,
  type ThreadView,
  type threadViewSchema,
} from '../src/contracts/index.js';

/** Exact type equality: drift from packages/host fails this compilation. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/** Compiles only when its type argument is `true`. */
const same = <T extends true>(): T => true as T;

type WithoutCall<F> = F extends (...args: infer P) => infer R
  ? P extends [...infer H, unknown?]
    ? (...args: H) => R
    : never
  : never;

type Controls<I> = { readonly [K in keyof I]: WithoutCall<I[K]> };

const parity = {
  threadView: same<Equal<ThreadView, host.ThreadView>>(),
  threadEventView: same<Equal<ThreadEventView, host.ThreadEventView>>(),
  threadResult: same<Equal<ThreadResult, host.ThreadResult>>(),
  threadPage: same<Equal<ThreadPage, host.ThreadPage>>(),
  threadSummary: same<Equal<ThreadSummary, host.ThreadSummary>>(),
  threadEventsPage: same<Equal<ThreadEventsPage, host.ThreadEventsPage>>(),
  spawnedThread: same<Equal<SpawnedThread, host.SpawnedThread>>(),
  promptResult: same<Equal<PromptResult, host.PromptResult>>(),
  interruptResult: same<Equal<InterruptResult, host.InterruptResult>>(),
  cwdChange: same<Equal<CwdChange, host.CwdChange>>(),
  threads:
    same<
      Equal<
        Controls<RuntimeThreadControls>,
        { readonly [K in keyof host.ThreadControl]: host.ThreadControl[K] }
      >
    >(),
  setCwd:
    same<
      Equal<
        WithoutCall<RuntimeWorkspace['setCwd']>,
        host.WorkspaceControl['setCwd']
      >
    >(),
  exec: same<Equal<LeaseExecInput, Omit<SandboxExecInput, 'signal'>>>(),
  viewSchema:
    same<z.output<typeof threadViewSchema> extends ThreadView ? true : false>(),
} as const;

void test('runtime contracts mirror the packages/host types', () => {
  assert.deepEqual(
    Object.values(parity),
    Object.values(parity).map(() => true),
  );
});

void test('a stored Thread record with keys outside ThreadView travels unchanged', async () => {
  const record = {
    id: 't-1',
    projectId: 'p-1',
    parentThreadId: 'parent',
    name: 'Child',
    state: 'ready',
    lastSequence: 4,
    cwd: '/workspace/repo',
    cwdRepo: 'git',
    queuePaused: false,
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:01.000Z',
    result: {
      status: 'completed',
      text: 'done',
      promptId: 'q-1',
      at: '2026-10-09T00:00:02.000Z',
    },
  };
  const unused = () => Promise.reject(new Error('not used'));
  const methods = Object.fromEntries(
    Object.entries(runtimeThreadsMethods).map(([name, spec]) => [
      name,
      defineMethod({ ...spec, execute: unused } as never),
    ]),
  );
  const harness = createTestServices({
    bundle: { id: 'consumer' },
    provide: [
      defineService(RuntimeThreadsV1, {
        ...methods,
        get: defineMethod({
          ...runtimeThreadsMethods.get,
          execute: async () => ({ thread: record, result: record.result }),
        }),
        terminate: defineMethod({
          ...runtimeThreadsMethods.terminate,
          execute: async () => record,
        }),
      } as never),
    ],
  });
  const threads = harness.services.use(RuntimeThreadsV1);
  const call = harness.call({
    projectId: 'p-1',
    threadId: 'parent',
    promptId: 'q',
  });

  const summary = await threads.get('t-1', call);
  assert.equal(summary.thread, record);
  assert.equal(JSON.stringify(summary.thread), JSON.stringify(record));
  assert.equal(await threads.terminate('t-1', call), record);
  await harness.dispose();
});
