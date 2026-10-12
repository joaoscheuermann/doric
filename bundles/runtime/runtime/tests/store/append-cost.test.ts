import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { memoryBackend, snapshot, stores } from './support.js';

/*
 * The per-event storage cost of a streamed run (design 57 R6,
 * host-stages-crossreview G-12): 10k `text.delta` appends to one Thread.
 * Each append is one commit plus one read of the entry it wrote (the
 * backend's commit time is the event's `createdAt`); the Thread document
 * comes from the store's cache, so no append reads it again. The elapsed
 * time is reported, not asserted, since it depends on the machine.
 */

const events = 10_000;

void test('appends 10k streamed events with one commit and one read each', async (context) => {
  const backend = memoryBackend();
  try {
    const { projects, threads } = stores(backend.storage);
    const { project } = await projects.create('Cost', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const promptId = randomUUID();
    await threads.appendEvent(thread.id, promptId, {
      type: 'prompt.accepted',
      text: 'stream',
      source: { kind: 'user' },
    });
    backend.calls.clear();
    const started = performance.now();
    for (let index = 0; index < events; index += 1)
      await threads.appendEvent(thread.id, promptId, {
        type: 'text.delta',
        delta: `chunk ${index} `,
      });
    const elapsed = performance.now() - started;
    context.diagnostic(
      `${events} appends in ${elapsed.toFixed(0)} ms (${((elapsed * 1000) / events).toFixed(0)} µs each, memory backend)`,
    );
    assert.equal(backend.calls.get('commit'), events);
    assert.equal(backend.calls.get('read'), events);
    assert.equal(backend.calls.get('get') ?? 0, 0);
    assert.equal(backend.calls.get('query') ?? 0, 0);
    const record = await threads.record(thread.id);
    assert.equal(record?.lastSequence, events + 1);
    const page = await threads.eventsAfterPage(thread.id, events - 1, 10);
    assert.deepEqual(
      page.events.map(({ sequence }) => sequence),
      [events, events + 1],
    );
  } finally {
    await backend.close();
  }
});
