/**
 * Streams over `storage/v2` (T4.3): v1's S1–S6 on binary events of the
 * run-time stream prefix `conformance.note.events/` (`streamFiles`), and
 * T4.3's 3 MiB event (`T4.3-event-3MiB`). The engine refuses stream items
 * and `Read` until S78, so every case is skipped with `untilS78`.
 */
import assert from 'node:assert/strict';

import { toBinary } from '@bufbuild/protobuf';

import type { Storage } from '../../client/types.js';
import { eventPrefix, type StreamFiles, streamFiles, textOf } from './files.js';
import { entries } from './fixtures.js';
import {
  caseGroup,
  conformanceBundle,
  conformanceFiles,
  untilS78,
  type V2Case,
  type V2Harness,
} from './harness.js';
import { isCode } from './support.js';

const sequences = caseGroup('sequence with gaps');
const stream = `${eventPrefix}t1`;
const other = `${eventPrefix}t2`;
const mib = 1_048_576;
/** The most bytes of one appended event's binary value (A34). */
const appendBytes = 3 * mib;

/** ISO-8601 with milliseconds in UTC, as `Date.prototype.toISOString` writes it. */
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** An instance over the conformance files and the stream files, and its events. */
const opened = async (
  harness: V2Harness,
  files: StreamFiles = streamFiles(),
): Promise<{
  readonly storage: Storage;
  readonly event: (text: string) => ReturnType<typeof textOf>;
}> => ({
  storage: await harness.open(conformanceBundle, [
    ...conformanceFiles,
    files.file,
  ]),
  event: (text) => textOf(files.event, text),
});

const marksFor = async (
  storage: Storage,
  afterSequence: number,
  name = stream,
) =>
  (await storage.read({ stream: name, afterSequence, limit: 10 })).truncations;

const empty = { entries: [], lastSequence: 0, truncations: [] };

/**
 * The cases, in run order, group `sequence with gaps`: S1–S6, then
 * `T4.3-event-3MiB`, all with `skip: untilS78`.
 */
export const streamCases: readonly V2Case[] = Object.freeze([
  sequences(
    'S1',
    'appends number entries from 1 with a protocol timestamp, and batches continue each other',
    async (harness) => {
      const { storage, event } = await opened(harness);

      assert.deepEqual(
        await storage.read({ stream, afterSequence: 0, limit: 10 }),
        empty,
      );
      await storage.commit({
        append: [{ stream, events: [event('a'), event('b')] }],
      });
      // Two appends to one stream in one batch continue each other.
      await storage.commit({
        append: [
          { stream, events: [event('c')] },
          { stream: other, events: [event('x')] },
          { stream, expectedSequence: 3, events: [event('d'), event('e')] },
        ],
      });

      assert.deepEqual(await entries(storage, stream), [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
        [4, 'd'],
        [5, 'e'],
      ]);
      assert.deepEqual(await entries(storage, other), [[1, 'x']]);

      const page = await storage.read({ stream, afterSequence: 0, limit: 10 });

      assert.equal(page.lastSequence, 5);

      for (const { createdAt } of page.entries) {
        assert.match(createdAt, iso);
        assert.equal(new Date(createdAt).toISOString(), createdAt);
      }
    },
    { skip: untilS78 },
  ),
  sequences(
    'S2',
    'a read returns the entries after its cursor, at most its limit',
    async (harness) => {
      const { storage, event } = await opened(harness);

      await storage.commit({
        append: [{ stream, events: ['1', '2', '3', '4', '5'].map(event) }],
      });

      const page = await storage.read({ stream, afterSequence: 1, limit: 2 });

      assert.deepEqual(
        page.entries.map(({ sequence, value }) => [
          sequence,
          (value as unknown as { text: string }).text,
        ]),
        [
          [2, '2'],
          [3, '3'],
        ],
      );
      assert.equal(page.lastSequence, 5);
      assert.deepEqual(
        (
          await storage.read({ stream, afterSequence: 3, limit: 10 })
        ).entries.map(({ sequence }) => sequence),
        [4, 5],
      );
      // Reading at the end is empty but still reports the counter.
      assert.deepEqual(
        await storage.read({ stream, afterSequence: 5, limit: 10 }),
        { entries: [], lastSequence: 5, truncations: [] },
      );
      // Another instance reads the same entries.
      assert.deepEqual(
        await entries((await opened(harness)).storage, stream, 4),
        [[5, '5']],
      );
    },
    { skip: untilS78 },
  ),
  sequences(
    'S3',
    'truncation removes the tail, keeps the counter, and the next append leaves a gap',
    async (harness) => {
      const { storage, event } = await opened(harness);

      await storage.commit({
        append: [{ stream, events: ['1', '2', '3', '4', '5'].map(event) }],
      });
      await storage.commit({ truncate: { stream, afterSequence: 2 } });

      const truncated = await storage.read({
        stream,
        afterSequence: 0,
        limit: 10,
      });

      assert.equal(truncated.lastSequence, 5);
      assert.deepEqual(
        truncated.entries.map(({ sequence }) => sequence),
        [1, 2],
      );

      await storage.commit({ append: [{ stream, events: [event('6')] }] });
      await storage.commit({
        append: [{ stream, expectedSequence: 6, events: [event('7')] }],
      });
      // Reading across the gap.
      assert.deepEqual(await entries(storage, stream, 1), [
        [2, '2'],
        [6, '6'],
        [7, '7'],
      ]);
      // A reader positioned in the removed tail reads on.
      assert.deepEqual(await entries(storage, stream, 4), [
        [6, '6'],
        [7, '7'],
      ]);

      // Truncating at the end removes nothing; truncating everything keeps the counter.
      await storage.commit({ truncate: { stream, afterSequence: 7 } });
      await storage.commit({ truncate: { stream, afterSequence: 0 } });
      assert.deepEqual(
        (await storage.read({ stream, afterSequence: 0, limit: 10 })).entries,
        [],
      );
      await storage.commit({ append: [{ stream, events: [event('8')] }] });
      assert.deepEqual(await entries(storage, stream), [[8, '8']]);
    },
    { skip: untilS78 },
  ),
  sequences(
    'S4',
    'truncation marks reach exactly the readers that may hold removed entries',
    async (harness) => {
      const { storage, event } = await opened(harness);

      await storage.commit({
        append: [{ stream, events: ['1', '2', '3', '4', '5'].map(event) }],
      });
      // The mark records the counter at the end of the batch, appends included.
      await storage.commit({
        truncate: { stream, afterSequence: 2 },
        append: [{ stream, events: [event('6')] }],
      });

      const mark = { afterSequence: 2, atSequence: 6 };

      assert.deepEqual(await marksFor(storage, 0), []);
      assert.deepEqual(await marksFor(storage, 2), []);
      assert.deepEqual(await marksFor(storage, 3), [mark]);
      assert.deepEqual(await marksFor(storage, 6), [mark]);

      // A later truncation adds its own mark beside the first.
      await storage.commit({ truncate: { stream, afterSequence: 1 } });

      const later = { afterSequence: 1, atSequence: 6 };

      assert.deepEqual(await marksFor(storage, 1), []);
      assert.deepEqual(await marksFor(storage, 2), [later]);
      assert.deepEqual(await marksFor(storage, 3), [mark, later]);

      // Appends after the marks do not move them; a reader past them sees none.
      await storage.commit({ append: [{ stream, events: [event('7')] }] });
      assert.deepEqual(await marksFor(storage, 6), [mark, later]);
      assert.deepEqual(await marksFor(storage, 7), []);
      // Marks belong to their stream.
      await storage.commit({
        append: [{ stream: other, events: [event('x'), event('y')] }],
      });
      assert.deepEqual(await marksFor(storage, 2, other), []);
    },
    { skip: untilS78 },
  ),
  sequences(
    'S5',
    'reading or truncating after the last sequence is invalid_input',
    async (harness) => {
      const { storage, event } = await opened(harness);

      await assert.rejects(
        storage.read({ stream, afterSequence: 1, limit: 10 }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        storage.commit({ truncate: { stream, afterSequence: 1 } }),
        isCode('invalid_input'),
      );
      await storage.commit({
        append: [{ stream, events: [event('a'), event('b')] }],
      });
      await storage.commit({ truncate: { stream, afterSequence: 0 } });
      // The counter, not the entries left, is the bound.
      assert.equal(
        (await storage.read({ stream, afterSequence: 2, limit: 10 }))
          .lastSequence,
        2,
      );
      await assert.rejects(
        storage.read({ stream, afterSequence: 3, limit: 10 }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        storage.commit({ truncate: { stream, afterSequence: 3 } }),
        isCode('invalid_input'),
      );
    },
    { skip: untilS78 },
  ),
  sequences(
    'S6',
    'an absent stream reads empty at 0; a dropped stream loses its entries and marks and starts again at 1',
    async (harness) => {
      const { storage, event } = await opened(harness);

      // A stream never appended to reads empty at 0.
      assert.deepEqual(
        await storage.read({ stream, afterSequence: 0, limit: 10 }),
        empty,
      );
      await storage.commit({
        append: [
          { stream, events: ['1', '2', '3'].map(event) },
          { stream: other, events: [event('kept')] },
        ],
      });
      await storage.commit({ truncate: { stream, afterSequence: 1 } });
      await storage.commit({
        dropStreams: [stream, `${eventPrefix}never`],
      });
      assert.deepEqual(
        await storage.read({ stream, afterSequence: 0, limit: 10 }),
        empty,
      );
      assert.deepEqual(await entries(storage, other), [[1, 'kept']]);

      await storage.commit({ append: [{ stream, events: [event('a')] }] });
      assert.deepEqual(await entries(storage, stream), [[1, 'a']]);

      // Dropping and appending in one batch: the append starts the stream over.
      await storage.commit({
        dropStreams: [stream],
        append: [{ stream, expectedSequence: 0, events: [event('b')] }],
      });

      const restarted = await storage.read({
        stream,
        afterSequence: 0,
        limit: 10,
      });

      assert.deepEqual(
        restarted.entries.map(({ sequence }) => sequence),
        [1],
      );
      assert.equal(restarted.lastSequence, 1);
      assert.deepEqual(restarted.truncations, []);
      assert.deepEqual(await entries(storage, stream), [[1, 'b']]);
    },
    { skip: untilS78 },
  ),
  sequences(
    'T4.3-event-3MiB',
    'an event of 3 MiB round trips in chunks, and one byte more is limit_exceeded',
    async (harness) => {
      const files = streamFiles();
      const { storage } = await opened(harness, files);
      // `NoteEvent { text }`: a tag byte, a 4-byte length and the text.
      const sized = (bytes: number) =>
        textOf(files.event, 'e'.repeat(bytes - 5));
      const largest = sized(appendBytes);

      assert.equal(toBinary(files.event, largest).length, appendBytes);
      await storage.commit({ append: [{ stream, events: [largest] }] });

      const page = await storage.read({ stream, afterSequence: 0, limit: 10 });

      assert.equal(page.entries.length, 1);
      assert.ok(
        Buffer.from(
          toBinary(files.event, page.entries[0]?.value as never),
        ).equals(Buffer.from(toBinary(files.event, largest))),
        'the event reads back byte for byte',
      );
      await assert.rejects(
        storage.commit({
          append: [{ stream, events: [sized(appendBytes + 1)] }],
        }),
        isCode('limit_exceeded'),
      );
      // The refused batch changed nothing.
      assert.equal(
        (await storage.read({ stream, afterSequence: 0, limit: 10 }))
          .lastSequence,
        1,
      );
    },
    { skip: untilS78, timeout: 300_000 },
  ),
]);
