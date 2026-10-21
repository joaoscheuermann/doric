import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { mergeDeltas, type StreamDelta } from '../../src/contracts/deltas.js';
import { memoryBackend, snapshot, stores } from './support.js';

/*
 * The storage cost of a streamed run (design 57 R6, host-stages-crossreview
 * G-12): 10k `text.delta` tokens to one Thread. The executor writes them
 * coalesced — here `batch` tokens per event, merged by the shared rule, as a
 * window of a fast stream holds them — so the run costs one append per event,
 * not per token. Each append is one commit plus one read of the entry it
 * wrote (the backend's commit time is the event's `createdAt`); the Thread
 * document comes from the store's cache, so no append reads it again. The
 * elapsed time is reported, not asserted, since it depends on the machine.
 */

const tokens = 10_000;
const batch = 25;

/** The tokens as one coalesced event per `batch`. */
const coalesced = (): StreamDelta[] => {
  const events: StreamDelta[] = [];
  for (let start = 0; start < tokens; start += batch) {
    let event: StreamDelta | undefined;
    for (
      let index = start;
      index < Math.min(start + batch, tokens);
      index += 1
    ) {
      const token: StreamDelta = {
        type: 'text.delta',
        delta: `chunk ${index} `,
      };
      event = event === undefined ? token : mergeDeltas(event, token);
    }
    if (event !== undefined) events.push(event);
  }
  return events;
};

void test('stores 10k streamed tokens coalesced with one commit and one read per event', async (context) => {
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
    const events = coalesced();
    backend.calls.clear();
    const started = performance.now();
    for (const event of events)
      await threads.appendEvent(thread.id, promptId, event);
    const elapsed = performance.now() - started;
    context.diagnostic(
      `${tokens} tokens in ${events.length} appends in ${elapsed.toFixed(0)} ms (memory backend)`,
    );
    const commits = backend.calls.get('commit') ?? 0;
    assert.ok(commits <= Math.ceil(tokens / batch));
    assert.equal(commits, events.length);
    assert.equal(backend.calls.get('read'), events.length);
    assert.equal(backend.calls.get('get') ?? 0, 0);
    assert.equal(backend.calls.get('query') ?? 0, 0);
    const record = await threads.record(thread.id);
    assert.equal(record?.lastSequence, events.length + 1);
    const stored = await threads.eventsAfter(thread.id, 1);
    assert.equal(
      stored.map(({ event }) => (event as { delta: string }).delta).join(''),
      Array.from({ length: tokens }, (_value, index) => `chunk ${index} `).join(
        '',
      ),
    );
  } finally {
    await backend.close();
  }
});
