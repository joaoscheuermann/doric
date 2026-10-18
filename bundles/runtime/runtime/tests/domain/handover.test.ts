import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadEvent } from '../../src/contracts/model.js';
import type { RuntimeOwner } from '../../src/contracts/runtime.js';
import {
  type ProjectDocument,
  projectType,
} from '../../src/contracts/storage.js';
import {
  type Backend,
  memoryBackend,
  postgresBackend,
} from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import {
  createHarness,
  deferred,
  type Harness,
  type HarnessRun,
  waitUntil,
} from './support/harness.js';

/*
 * Generation handover (57-WP-H, cross-review G-1): two runtime processes over
 * the same storage, the replaced generation N and its successor M. N lets its
 * running prompts finish on its own lease (stage-4 evidence E2), M leaves N's
 * Projects alone until N lets them go and then adopts them, and a draining N
 * that dies has its Projects reconciled by M as after a host restart (E3c).
 */

const first: RuntimeOwner = { generation: 1, incarnation: 1 };
const second: RuntimeOwner = { generation: 2, incarnation: 1 };

const backends: readonly {
  readonly name: string;
  readonly make: () => Promise<Backend>;
  readonly skip: boolean;
}[] = [
  { name: 'memory', make: async () => memoryBackend(), skip: false },
  {
    name: 'PostgreSQL',
    make: postgresBackend,
    skip: process.env.DORIC_TEST_DATABASE_URL === undefined,
  },
];

/** One runtime process over `backend`, with its own sandbox pool. */
const processOf = (
  backend: Backend,
  owner: RuntimeOwner,
  execute: (run: HarnessRun) => Promise<string>,
): Harness =>
  createHarness({
    backend,
    generation: async () => owner,
    sandbox: { sandbox: fakeSandbox() as never },
    execute,
  });

const storedOwner = async (backend: Backend, id: string) =>
  (
    (await backend.storage.get({ type: projectType.type, id }))?.value as
      | ProjectDocument
      | undefined
  )?.owner;

const eventsOf = async (harness: Harness, threadId: string) =>
  (await harness.service.threads.events(threadId, 0))?.events ?? [];

const types = (events: readonly ThreadEvent[], promptId: string) =>
  events
    .filter((event) => event.promptId === promptId)
    .map((event) => (event.event as { type: string }).type);

/** Whether `promise` settled within a few event-loop turns. */
const settles = async (promise: Promise<unknown>): Promise<boolean> => {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < 20; turn += 1)
    await new Promise((done) => setTimeout(done, 1));
  return settled;
};

for (const { name, make, skip } of backends) {
  void test(`${name}: a draining process finishes its running prompt before its successor adopts the Project`, {
    skip,
    timeout: 20_000,
  }, async () => {
    const backend = await make();
    const ran: string[] = [];
    const firstRun = deferred<string>();
    const n = processOf(backend, first, async ({ job }) => {
      ran.push(`N ${job.prompt}`);
      return job.prompt === 'first' ? firstRun.promise : 'done';
    });
    let m: Harness | undefined;
    try {
      const project = await n.readyProject();
      const thread = await n.createThread(project.id);
      const accepted = await n.service.threads.prompt(thread.id, 'first');
      assert.equal(accepted.status, 'accepted');
      const firstId = (accepted as { promptId: string }).promptId;
      // The run started: `prompt.started` precedes the executor call.
      await waitUntil(() => ran.includes('N first'), 'N runs the prompt');

      // The Project records its owner, and only internally.
      assert.deepEqual(await storedOwner(backend, project.id), first);
      assert.equal(
        Object.hasOwn((await n.runtime.project(project.id)) ?? {}, 'owner'),
        false,
      );

      const started = n.sandbox.acquired.length;
      const mRuns: string[] = [];
      m = processOf(backend, second, async ({ job }) => {
        ran.push(`M ${job.prompt}`);
        mRuns.push(job.prompt);
        return 'done';
      });

      // The successor's recovery leaves the live owner's Project alone.
      assert.deepEqual(await m.runtime.recoverWith({ live: [first] }), {
        interruptedThreads: 0,
        interruptedProjects: 0,
        resumedPrompts: 0,
      });
      assert.equal(
        (await m.stores.threads.record(thread.id))?.state,
        'running',
      );
      assert.deepEqual(m.sandbox.acquired, []);
      assert.deepEqual(types(await eventsOf(m, thread.id), firstId), [
        'prompt.accepted',
        'queue.updated',
        'prompt.started',
      ]);

      // A new prompt reaching the successor waits for the handover.
      const next = m.service.threads.prompt(thread.id, 'second');
      const ssh = m.service.projects.ssh(project.id);
      assert.equal(await settles(next), false);
      assert.equal(await settles(ssh), false);

      const released: string[] = [];
      const adoptions: Promise<void>[] = [];
      const drained = n.runtime.drain((projectId) => {
        released.push(projectId);
        adoptions.push((m as Harness).runtime.adopt({ live: [first] }));
      });
      // The running prompt keeps the Project and its lease on N.
      assert.equal(await settles(drained), false);
      assert.deepEqual(released, []);
      assert.equal(n.sandbox.released, 0);

      firstRun.resolve('first done');
      await drained;
      await Promise.all(adoptions);
      assert.deepEqual(released, [project.id]);
      assert.equal(n.sandbox.released, started);

      const answered = await next;
      assert.equal(answered.status, 'accepted');
      // Answered once adopted, as for a Project just brought back.
      assert.ok(['pending', 'ready'].includes((await ssh).status));
      await waitUntil(() => mRuns.includes('second'), 'M runs the new prompt');
      await waitUntil(
        async () =>
          (await eventsOf(m as Harness, thread.id)).some(
            (event) =>
              event.promptId !== firstId &&
              (event.event as { type: string }).type === 'prompt.finished',
          ),
        'the new prompt settles',
      );

      // One lease at a time: M acquired only after N released.
      assert.deepEqual(m.sandbox.acquired, [project.id]);
      assert.deepEqual(ran, ['N first', 'M second']);
      const events = await eventsOf(m, thread.id);
      assert.deepEqual(types(events, firstId), [
        'prompt.accepted',
        'queue.updated',
        'prompt.started',
        'prompt.finished',
        'queue.updated',
      ]);
      assert.equal(
        events.some(
          (event) => (event.event as { type: string }).type === 'prompt.paused',
        ),
        false,
      );
      assert.deepEqual(await storedOwner(backend, project.id), second);
    } finally {
      firstRun.resolve('first done');
      await m?.dispose();
      await n.dispose();
      await backend.close();
    }
  });

  void test(`${name}: a Project whose draining owner died is reconciled and resumed by its successor`, {
    skip,
    timeout: 20_000,
  }, async () => {
    const backend = await make();
    // N's run never ends on its own; only the test's final stop aborts it.
    let running = false;
    const n = processOf(
      backend,
      first,
      ({ signal }) =>
        new Promise<string>((_, reject) => {
          running = true;
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    let m: Harness | undefined;
    try {
      const project = await n.readyProject();
      const thread = await n.createThread(project.id);
      const accepted = await n.service.threads.prompt(thread.id, 'work');
      const promptId = (accepted as { promptId: string }).promptId;
      await waitUntil(() => running, 'N runs the prompt');

      const resumed: string[] = [];
      m = processOf(backend, second, async ({ job }) => {
        resumed.push(job.prompt);
        return 'done';
      });
      await m.runtime.recoverWith({ live: [first] });
      assert.equal(
        (await m.stores.threads.record(thread.id))?.state,
        'running',
      );

      // N dies while draining (its process is gone; nothing it holds runs).
      await m.runtime.adopt({ live: [] });

      await waitUntil(() => resumed.includes('work'), 'M resumes the prompt');
      await waitUntil(
        async () =>
          types(await eventsOf(m as Harness, thread.id), promptId).length === 9,
        'the resumed prompt settles',
      );
      const events = await eventsOf(m, thread.id);
      assert.deepEqual(types(events, promptId), [
        'prompt.accepted',
        'queue.updated',
        'prompt.started',
        'prompt.paused',
        'prompt.resumed',
        'queue.updated',
        'prompt.started',
        'prompt.finished',
        'queue.updated',
      ]);
      const paused = events.find(
        (event) => (event.event as { type: string }).type === 'prompt.paused',
      );
      assert.equal(
        (paused?.event as { reason?: string } | undefined)?.reason,
        'host_restarted',
      );
      assert.deepEqual(m.sandbox.acquired, [project.id]);
      assert.deepEqual(await storedOwner(backend, project.id), second);
    } finally {
      await m?.dispose();
      await n.dispose();
      await backend.close();
    }
  });

  void test(`${name}: without a live process every recorded owner is a restart's leftover`, {
    skip,
    timeout: 20_000,
  }, async () => {
    const backend = await make();
    const n = processOf(backend, first, async () => 'done');
    let m: Harness | undefined;
    try {
      const project = await n.readyProject();
      await n.createThread(project.id);
      // The host crashed: N never let its Project go.
      assert.deepEqual(await storedOwner(backend, project.id), first);

      m = processOf(backend, second, async () => 'done');
      const summary = await m.runtime.recover();
      assert.equal(summary.interruptedProjects, 1);
      await m.projectState(project.id, 'ready');
      assert.deepEqual(m.sandbox.acquired, [project.id]);
      assert.deepEqual(await storedOwner(backend, project.id), second);

      // A host stop lets the Project go.
      await m.runtime.dispose();
      assert.equal(await storedOwner(backend, project.id), null);
    } finally {
      await m?.dispose();
      await n.dispose();
      await backend.close();
    }
  });
}
