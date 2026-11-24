// `runtime.threads/v1.ThreadEvents` over the router stops a page before 3 MiB
// (phase 3, slice S62b, C3, tests 12–13): the answer is the longest prefix of
// the events after the cursor whose `ThreadEventsResponse` encodes below
// 3 MiB, at least one event, with the uncut log's `lastSequence`; the caller
// continues from the page's last sequence. A log under 3 MiB answers as before.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { describe, type TestContext } from 'node:test';

import { create, toBinary } from '@bufbuild/protobuf';

import {
  type ThreadEventsResponse,
  ThreadEventsResponseSchema,
} from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { type Harness, harness, seedThread } from './support.js';

/** 3 MiB, the largest encoded `ThreadEventsResponse` (S62b D5). */
const threadEventsMaxBytes = 3 * 1024 * 1024;
const unknownId = '00000000-0000-4000-8000-00000000ffff';

const encodedBytes = (response: ThreadEventsResponse) =>
  toBinary(ThreadEventsResponseSchema, response).byteLength;

const sequencesOf = (response: ThreadEventsResponse): number[] =>
  response.threadEventLog?.events.map(({ sequence }) => sequence) ?? [];

/** 1..`count`, the sequences of a Thread's first `count` events. */
const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1);

/** A started harness with one Thread whose events carry `texts`, in order. */
const threadWith = async (
  t: TestContext,
  texts: readonly string[],
): Promise<{ h: Harness; threadId: string }> => {
  const h = harness();
  t.after(() => h.stop());
  const { thread } = await seedThread(h);
  const promptId = randomUUID();
  for (const [index, text] of texts.entries())
    await h.seed.threads.appendEvent(thread.id, promptId, {
      type: 'note',
      index,
      text,
    });
  await h.start();
  return { h, threadId: thread.id };
};

describe('S62b: runtime.threads/v1 ThreadEvents stops before 3 MiB', () => {
  test('12: a log above 3 MiB answers the longest prefix under 3 MiB with the uncut lastSequence, and the next call continues from its last sequence', async (t) => {
    const total = 14;
    const { h, threadId } = await threadWith(
      t,
      Array.from({ length: total }, () => 'x'.repeat(256 * 1024)),
    );

    const first = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: 0 });

    const log = first.threadEventLog;
    assert.ok(log !== undefined, 'the Thread has a log');
    assert.ok(log.events.length > 0, 'a non-empty prefix');
    assert.ok(encodedBytes(first) < threadEventsMaxBytes, 'under 3 MiB');
    assert.equal(log.lastSequence, total, 'the uncut log’s lastSequence');
    const last = log.events.at(-1)?.sequence ?? 0;
    assert.ok(last < log.lastSequence, 'the page was cut');
    assert.deepEqual(sequencesOf(first), range(log.events.length));

    // The longest prefix: the next event would cross 3 MiB.
    const second = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: last });
    const next = second.threadEventLog?.events[0];
    assert.ok(next !== undefined, 'the next call answers the next event');
    assert.equal(next.sequence, last + 1, 'no event skipped');
    const fuller = create(ThreadEventsResponseSchema, {
      threadEventLog: { ...log, events: [...log.events, next] },
    });
    assert.ok(encodedBytes(fuller) >= threadEventsMaxBytes, 'the page is full');

    // Following each page's last sequence reads every event once.
    const read = [...sequencesOf(first)];
    let page = second;
    for (let calls = 2; ; calls += 1) {
      assert.ok(calls <= total, 'the pages advance');
      assert.equal(page.threadEventLog?.lastSequence, total);
      assert.ok(
        encodedBytes(page) < threadEventsMaxBytes,
        'each page under 3 MiB',
      );
      read.push(...sequencesOf(page));
      const cursor = read.at(-1) ?? 0;
      if (cursor >= total) break;
      page = await h
        .threads()
        .threadEvents({ id: threadId, afterSequence: cursor });
    }
    assert.deepEqual(read, range(total), 'no event twice and none skipped');
  });

  test('13a: a log under 3 MiB answers whole, with its lastSequence', async (t) => {
    const { h, threadId } = await threadWith(t, ['one', 'two', 'three']);

    const response = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: 0 });

    assert.deepEqual(sequencesOf(response), [1, 2, 3]);
    assert.equal(response.threadEventLog?.lastSequence, 3);
    const after = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: 1 });
    assert.deepEqual(sequencesOf(after), [2, 3]);
    assert.equal(after.threadEventLog?.lastSequence, 3);
  });

  test('13b: a single event above 3 MiB (below 4 MiB) is answered alone', async (t) => {
    const { h, threadId } = await threadWith(t, [
      'small',
      'x'.repeat(3 * 1024 * 1024 + 256 * 1024),
      'small',
    ]);

    const first = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: 0 });
    const big = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: 1 });
    const rest = await h
      .threads()
      .threadEvents({ id: threadId, afterSequence: 2 });

    assert.deepEqual(sequencesOf(first), [1], 'the big event is not joined');
    assert.equal(first.threadEventLog?.lastSequence, 3);
    assert.deepEqual(sequencesOf(big), [2], 'the big event goes alone');
    assert.equal(big.threadEventLog?.lastSequence, 3);
    assert.ok(encodedBytes(big) >= threadEventsMaxBytes, 'above 3 MiB');
    assert.deepEqual(sequencesOf(rest), [3]);
    assert.equal(rest.threadEventLog?.lastSequence, 3);
  });

  test('13c: an unknown Thread answers no threadEventLog', async (t) => {
    const h = harness();
    t.after(() => h.stop());
    await h.start();

    const response = await h
      .threads()
      .threadEvents({ id: unknownId, afterSequence: 0 });

    assert.equal(response.threadEventLog, undefined);
  });
});
