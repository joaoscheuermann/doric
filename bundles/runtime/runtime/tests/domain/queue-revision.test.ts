import assert from 'node:assert/strict';
import test from 'node:test';

import type { ThreadQueue } from '../../src/contracts/model.js';
import { backends } from '../store/support.js';
import { fakeSandbox } from '../support/sandbox.js';
import { createHarness, deferred } from './support/harness.js';

/*
 * A reader keeps the newest queue snapshot by its revision (the renderer's
 * `latestQueue` drops one whose revision is lower than the cached one). So
 * every snapshot must carry the revision of the content it shows: a snapshot
 * read after another, with different content, must have a higher revision,
 * and a read issued once an event is announced must already count it.
 */

const content = (queue: ThreadQueue) => {
  const { revision: _revision, ...rest } = queue;
  return JSON.stringify(rest);
};

for (const backend of backends)
  void test(`${backend.name}: queue snapshots stay monotonic with their content while a paused queue resumes and finishes`, {
    timeout: 20000,
    skip: backend.skip,
  }, async () => {
    const started = deferred();
    const finished = deferred();
    let runs = 0;
    const storage = await backend.open();
    const harness = createHarness({
      backend: storage,
      sandbox: { sandbox: fakeSandbox() as never },
      execute: async ({ signal }) => {
        runs += 1;
        if (runs === 1) {
          started.resolve();
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
          return 'stopped';
        }
        for (let index = 0; index < 5; index += 1)
          await new Promise((resolve) => setImmediate(resolve));
        if (runs === 2) finished.resolve();
        return 'done';
      },
    });
    const { service } = harness;
    try {
      const project = await service.projects.create('Project');
      const created = await service.threads.create(project.id, 'Thread');
      if (created.status !== 'created') throw new Error('Thread unavailable');
      const id = created.thread.id;
      const active = await service.threads.prompt(id, 'active');
      if (active.status !== 'accepted') throw new Error('Prompt unavailable');
      await started.promise;
      await service.threads.prompt(id, 'next');
      await service.threads.interrupt(id, active.promptId);
      await harness.threadState(id, 'ready');
      // The stop ended the running turn and left the queue paused on the rest.
      const paused = await service.threads.queue(id);
      assert.equal(paused?.paused, true);
      assert.deepEqual(
        paused?.items.map((item) => item.preview),
        ['next'],
      );

      // Reads issued when an event is announced, checked against it.
      const announced: Promise<{ sequence: number; queue?: ThreadQueue }>[] =
        [];
      const stop = harness.listen((notice) => {
        if (notice.kind !== 'event' || notice.value.threadId !== id) return;
        const { sequence } = notice.value;
        announced.push(
          service.threads.queue(id).then((queue) => ({ sequence, queue })),
        );
      });
      // Back-to-back reads, each issued once the previous one answered.
      let reading = true;
      const sequential: ThreadQueue[] = [];
      const hammer = (async () => {
        while (reading) {
          const queue = await service.threads.queue(id);
          if (queue !== undefined) sequential.push(queue);
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      try {
        assert.equal((await service.threads.resumeQueue(id)).status, 'resumed');
        await finished.promise;
        await harness.threadState(id, 'ready');
        await harness.waitFor(
          async () => (await service.threads.queue(id))?.items.length === 0,
          'queue drained',
        );
      } finally {
        reading = false;
        stop();
        await hammer;
      }

      const last = (await service.threads.events(id, 0))?.events.at(-1);
      const final = await service.threads.queue(id);
      assert.equal(final?.revision, last?.sequence);
      assert.equal(final?.current, undefined);
      assert.equal(final?.resumable, undefined);
      assert.deepEqual(final?.items, []);

      assert.ok(sequential.length > 1);
      for (let index = 1; index < sequential.length; index += 1) {
        const before = sequential[index - 1] as ThreadQueue;
        const after = sequential[index] as ThreadQueue;
        assert.ok(
          after.revision >= before.revision,
          `revision went back from ${before.revision} to ${after.revision}`,
        );
        if (content(after) !== content(before))
          assert.ok(
            after.revision > before.revision,
            `content changed at revision ${after.revision} without a new revision:\n${content(before)}\n${content(after)}`,
          );
      }
      for (const { sequence, queue } of await Promise.all(announced))
        assert.ok(
          (queue?.revision ?? 0) >= sequence,
          `a read after event ${sequence} answered revision ${queue?.revision}`,
        );
    } finally {
      await harness.dispose();
      await storage.close();
    }
  });
