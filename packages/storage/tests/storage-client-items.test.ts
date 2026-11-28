// S77b2 (CI1–CI9, the drift fix of S77b1's client; CI10, an append's
// "at least one" event, `client/types.ts`'s `StreamAppend.events`): the
// `Commit` items the `storage/v2` client sends (spec
// `docs/designs/grpc-processes.md`, "The TypeScript client": "It splits values
// into chunks of at most 1 MiB", "A type or stream the client has no message
// for is `invalid_input` before any call"; `storage.proto`'s `CommitRequest`:
// an append is followed by its events, each an `event` item with the first
// chunk of the event's binary, at most 1 MiB and at least 1 byte, and `chunk`
// items with the rest). These cases read the items at the client's
// boundary, on a recording router.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { create, toBinary } from '@bufbuild/protobuf';
import type { CommitRequest } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';

import { refusal } from '../src/conformance/kv/support.js';
import { feedFile } from './support/descriptors.js';
import { recordingStorage } from './support/recording-storage.js';

const mib = 1_048_576;
const feed = feedFile();
const files = [feed.file];
const stream = 'conformance.feed/one';
const undeclared = 'undeclared.stream/x';

/**
 * A `FeedEvent` whose binary is `bytes` long: the tag (1 byte), the text's
 * length as a varint (`varintBytes`) and the text.
 */
const eventOf = (bytes: number, varintBytes: number) =>
  create(feed.event, { text: 'e'.repeat(bytes - 1 - varintBytes) });

/** Each item as its case and, for bytes, its length, so a diff reads. */
const shapes = (items: readonly CommitRequest['item'][]) =>
  items.map((item) =>
    item.value instanceof Uint8Array
      ? { case: item.case, bytes: item.value.length }
      : { case: item.case },
  );

/** The bytes of the `event` item at `start` joined with the `chunk`s after it. */
const eventBytes = (
  items: readonly CommitRequest['item'][],
  start: number,
): Buffer => {
  const parts: Uint8Array[] = [];

  for (const [index, item] of items.entries()) {
    if (index < start) {
      continue;
    }

    if (
      (index === start && item.case === 'event') ||
      (index > start && item.case === 'chunk')
    ) {
      parts.push(item.value);
    } else if (index > start) {
      break;
    }
  }

  return Buffer.concat(parts);
};

describe('the events an append sends', () => {
  test('CI1: a 3 MiB event is an event item of 1 MiB and chunks of the rest, each at most 1 MiB', async () => {
    const { storage, commits } = await recordingStorage(files);
    const event = eventOf(3 * mib, 4);
    const binary = toBinary(feed.event, event);

    assert.equal(binary.length, 3 * mib);
    await storage.commit({ append: [{ stream, events: [event] }] });

    const [items = []] = commits;

    assert.equal(commits.length, 1);
    assert.deepEqual(shapes(items), [
      { case: 'append' },
      { case: 'event', bytes: mib },
      { case: 'chunk', bytes: mib },
      { case: 'chunk', bytes: mib },
    ]);
    assert.ok(
      eventBytes(items, 1).equals(binary),
      'the items join to the event',
    );
  });

  test('CI2: an event under 1 MiB is one event item and no chunk', async () => {
    const { storage, commits } = await recordingStorage(files);
    const event = create(feed.event, { text: 'e' });

    await storage.commit({ append: [{ stream, events: [event] }] });

    const [items = []] = commits;

    assert.deepEqual(shapes(items), [
      { case: 'append' },
      { case: 'event', bytes: 3 },
    ]);
    assert.ok(
      eventBytes(items, 1).equals(toBinary(feed.event, event)),
      'the item holds the event',
    );
  });

  test('CI3: an event of exactly 1 MiB is one event item; one byte more adds a chunk of 1 byte', async () => {
    const { storage, commits } = await recordingStorage(files);
    const exact = eventOf(mib, 3);
    const over = eventOf(mib + 1, 3);

    assert.equal(toBinary(feed.event, exact).length, mib);
    assert.equal(toBinary(feed.event, over).length, mib + 1);
    await storage.commit({ append: [{ stream, events: [exact, over] }] });

    const [items = []] = commits;

    assert.deepEqual(shapes(items), [
      { case: 'append' },
      { case: 'event', bytes: mib },
      { case: 'event', bytes: mib },
      { case: 'chunk', bytes: 1 },
    ]);
    assert.ok(eventBytes(items, 2).equals(toBinary(feed.event, over)));
  });

  test("CI4: each event's chunks follow it, before the next event", async () => {
    const { storage, commits } = await recordingStorage(files);
    const big = eventOf(2 * mib + 10, 4);
    const small = create(feed.event, { text: 'next' });

    assert.equal(toBinary(feed.event, big).length, 2 * mib + 10);
    await storage.commit({ append: [{ stream, events: [big, small] }] });

    const [items = []] = commits;

    assert.deepEqual(shapes(items), [
      { case: 'append' },
      { case: 'event', bytes: mib },
      { case: 'chunk', bytes: mib },
      { case: 'chunk', bytes: 10 },
      { case: 'event', bytes: 6 },
    ]);
    assert.ok(eventBytes(items, 1).equals(toBinary(feed.event, big)));
    assert.ok(eventBytes(items, 4).equals(toBinary(feed.event, small)));
  });

  test('CI5: an empty event, which no event item can hold (min_len 1), is invalid_input before any call', async () => {
    const { storage, commits } = await recordingStorage(files);
    const empty = create(feed.event);

    assert.equal(toBinary(feed.event, empty).length, 0);
    await assert.rejects(
      storage.commit({ append: [{ stream, events: [empty] }] }),
      refusal('invalid_input'),
    );
    assert.deepEqual(commits.map(shapes), [], 'the client calls no Commit');
  });

  test('CI10: an append with no events, which must hold at least one, is invalid_input {stream} before any call', async () => {
    const { storage, commits } = await recordingStorage(files);

    await assert.rejects(
      storage.commit({ append: [{ stream, events: [] }] }),
      refusal('invalid_input', { stream }),
    );
    assert.deepEqual(commits.map(shapes), [], 'the client calls no Commit');
  });
});

describe('the streams a drop or a truncation names', () => {
  test('CI6: dropping a stream the client has no message for is invalid_input before any call', async () => {
    const { storage, commits } = await recordingStorage(files);

    await assert.rejects(
      storage.commit({ dropStreams: [undeclared] }),
      refusal('invalid_input'),
    );
    assert.deepEqual(commits.map(shapes), [], 'the client calls no Commit');
  });

  test('CI7: truncating a stream the client has no message for is invalid_input before any call', async () => {
    const { storage, commits } = await recordingStorage(files);

    await assert.rejects(
      storage.commit({ truncate: { stream: undeclared, afterSequence: 0 } }),
      refusal('invalid_input'),
    );
    assert.deepEqual(commits.map(shapes), [], 'the client calls no Commit');
  });

  test('CI8: an undeclared stream among declared ones refuses the whole batch before any call', async () => {
    const { storage, commits } = await recordingStorage(files);

    await assert.rejects(
      storage.commit({
        dropStreams: [stream, undeclared],
        append: [{ stream, events: [create(feed.event, { text: 'e' })] }],
      }),
      refusal('invalid_input'),
    );
    assert.deepEqual(commits.map(shapes), [], 'the client calls no Commit');
  });

  test('CI9: a drop and a truncation of a declared stream reach Commit as sent', async () => {
    const { storage, commits } = await recordingStorage(files);

    assert.deepEqual(
      await storage.commit({
        dropStreams: ['conformance.feed/old'],
        truncate: { stream, afterSequence: 2 },
      }),
      { position: 1 },
    );
    assert.equal(commits.length, 1);

    const [items = []] = commits;

    assert.deepEqual(
      items.map((item) =>
        item.case === 'truncate'
          ? {
              case: item.case,
              stream: item.value.stream,
              afterSequence: item.value.afterSequence,
            }
          : { case: item.case, value: item.value },
      ),
      [
        { case: 'dropStream', value: 'conformance.feed/old' },
        { case: 'truncate', stream, afterSequence: 2 },
      ],
    );
  });
});
