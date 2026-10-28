import assert from 'node:assert/strict';
import test from 'node:test';

import { defineMethod, defineService } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { SandboxExecInput } from 'sandbox';
import type { Terminal as TerminalRunner } from 'terminal/contracts';
import type { z } from 'zod';

import {
  type LeaseExecInput,
  type RuntimeThreadControls,
  RuntimeThreadsV1,
  type RuntimeWorkspace,
  runtimeThreadsMethods,
  type TerminalControl,
  type ThreadControl,
  type ThreadView,
  type threadViewSchema,
  type WorkspaceControl,
} from '../src/contracts/index.js';

/** Exact type equality: drift between the tool-host facade and its contracts fails compilation. */
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

type Run = TerminalRunner['run'] extends (
  input: infer I,
  call?: infer _C,
) => infer R
  ? (input: I) => R
  : never;

const parity = {
  threads:
    same<
      Equal<
        Controls<RuntimeThreadControls>,
        { readonly [K in keyof ThreadControl]: ThreadControl[K] }
      >
    >(),
  setCwd:
    same<
      Equal<WithoutCall<RuntimeWorkspace['setCwd']>, WorkspaceControl['setCwd']>
    >(),
  location:
    same<
      Equal<
        WithoutCall<RuntimeWorkspace['location']>,
        WorkspaceControl['location']
      >
    >(),
  terminalRun:
    same<
      Equal<
        Awaited<ReturnType<Run>>,
        Awaited<ReturnType<TerminalControl['run']>>
      >
    >(),
  exec: same<Equal<LeaseExecInput, Omit<SandboxExecInput, 'signal'>>>(),
  viewSchema:
    same<z.output<typeof threadViewSchema> extends ThreadView ? true : false>(),
} as const;

void test('the tool-host facade mirrors the runtime and terminal contracts', () => {
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
