import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { caseGroup } from './harness.js';
import { isCode, open, sequenced } from './support.js';

const stream = 'conformance.thread.events/t1';
const other = 'conformance.thread.events/t2';

/** ISO-8601 with milliseconds in UTC, as `Date.prototype.toISOString` writes it. */
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const marksFor = async (
  backend: StorageBackend,
  afterSequence: number,
  name = stream,
) =>
  (await backend.read({ stream: name, afterSequence, limit: 10 })).truncations;

const sequences = caseGroup('sequence with gaps');

export const streamCases = [
  sequences(
    'S1',
    'appends number entries from 1 with a protocol timestamp, and batches continue each other',
    async (harness) => {
      const backend = await open(harness);

      assert.deepEqual(
        await backend.read({ stream, afterSequence: 0, limit: 10 }),
        { entries: [], lastSequence: 0, truncations: [] },
      );

      await backend.commit({
        append: [{ stream, events: [{ type: 'a' }, { type: 'b' }] }],
      });
      // Two appends to one stream in one batch continue each other.
      await backend.commit({
        append: [
          { stream, events: ['c'] },
          { stream: other, events: ['x'] },
          { stream, expectedSequence: 3, events: ['d', 'e'] },
        ],
      });

      assert.deepEqual(await sequenced(backend, stream), [
        [1, { type: 'a' }],
        [2, { type: 'b' }],
        [3, 'c'],
        [4, 'd'],
        [5, 'e'],
      ]);
      assert.deepEqual(await sequenced(backend, other), [[1, 'x']]);

      const page = await backend.read({ stream, afterSequence: 0, limit: 10 });

      assert.equal(page.lastSequence, 5);

      for (const { createdAt } of page.entries) {
        assert.match(createdAt, iso);
        assert.equal(new Date(createdAt).toISOString(), createdAt);
      }
    },
  ),
  sequences(
    'S2',
    'a read returns the entries after its cursor, at most its limit',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({
        append: [{ stream, events: ['1', '2', '3', '4', '5'] }],
      });

      const page = await backend.read({ stream, afterSequence: 1, limit: 2 });

      assert.deepEqual(
        page.entries.map(({ sequence, value }) => [sequence, value]),
        [
          [2, '2'],
          [3, '3'],
        ],
      );
      assert.equal(page.lastSequence, 5);
      assert.deepEqual(
        (
          await backend.read({ stream, afterSequence: 3, limit: 10 })
        ).entries.map(({ sequence }) => sequence),
        [4, 5],
      );
      // Reading at the end is empty but still reports the counter.
      assert.deepEqual(
        await backend.read({ stream, afterSequence: 5, limit: 10 }),
        { entries: [], lastSequence: 5, truncations: [] },
      );
      // Another instance reads the same entries.
      assert.deepEqual(await sequenced(await open(harness), stream, 4), [
        [5, '5'],
      ]);
    },
  ),
  sequences(
    'S3',
    'truncation removes the tail, keeps the counter, and the next append leaves a gap',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({
        append: [{ stream, events: ['1', '2', '3', '4', '5'] }],
      });
      await backend.commit({ truncate: { stream, afterSequence: 2 } });

      const truncated = await backend.read({
        stream,
        afterSequence: 0,
        limit: 10,
      });

      assert.equal(truncated.lastSequence, 5);
      assert.deepEqual(
        truncated.entries.map(({ sequence }) => sequence),
        [1, 2],
      );

      await backend.commit({ append: [{ stream, events: ['6'] }] });
      await backend.commit({
        append: [{ stream, expectedSequence: 6, events: ['7'] }],
      });
      // Reading across the gap.
      assert.deepEqual(await sequenced(backend, stream, 1), [
        [2, '2'],
        [6, '6'],
        [7, '7'],
      ]);
      // A reader positioned in the removed tail reads on.
      assert.deepEqual(await sequenced(backend, stream, 4), [
        [6, '6'],
        [7, '7'],
      ]);

      // Truncating at the end removes nothing; truncating everything keeps the counter.
      await backend.commit({ truncate: { stream, afterSequence: 7 } });
      await backend.commit({ truncate: { stream, afterSequence: 0 } });
      assert.deepEqual(
        (await backend.read({ stream, afterSequence: 0, limit: 10 })).entries,
        [],
      );
      await backend.commit({ append: [{ stream, events: ['8'] }] });
      assert.deepEqual(await sequenced(backend, stream), [[8, '8']]);
    },
  ),
  sequences(
    'S4',
    'truncation marks reach exactly the readers that may hold removed entries',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({
        append: [{ stream, events: ['1', '2', '3', '4', '5'] }],
      });
      // The mark records the counter at the end of the batch, appends included.
      await backend.commit({
        truncate: { stream, afterSequence: 2 },
        append: [{ stream, events: ['6'] }],
      });

      const mark = { afterSequence: 2, atSequence: 6 };

      assert.deepEqual(await marksFor(backend, 0), []);
      assert.deepEqual(await marksFor(backend, 2), []);
      assert.deepEqual(await marksFor(backend, 3), [mark]);
      assert.deepEqual(await marksFor(backend, 6), [mark]);

      // A later truncation adds its own mark beside the first.
      await backend.commit({ truncate: { stream, afterSequence: 1 } });

      const later = { afterSequence: 1, atSequence: 6 };

      assert.deepEqual(await marksFor(backend, 1), []);
      assert.deepEqual(await marksFor(backend, 2), [later]);
      assert.deepEqual(await marksFor(backend, 3), [mark, later]);

      // Appends after the marks do not move them; a reader past them sees none.
      await backend.commit({ append: [{ stream, events: ['7'] }] });
      assert.deepEqual(await marksFor(backend, 6), [mark, later]);
      assert.deepEqual(await marksFor(backend, 7), []);
      // Marks belong to their stream.
      await backend.commit({ append: [{ stream: other, events: ['x', 'y'] }] });
      assert.deepEqual(await marksFor(backend, 2, other), []);
    },
  ),
  sequences(
    'S5',
    'reading or truncating after the last sequence is invalid_input',
    async (harness) => {
      const backend = await open(harness);

      await assert.rejects(
        backend.read({ stream, afterSequence: 1, limit: 10 }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        backend.commit({ truncate: { stream, afterSequence: 1 } }),
        isCode('invalid_input'),
      );
      await backend.commit({ append: [{ stream, events: ['a', 'b'] }] });
      await backend.commit({ truncate: { stream, afterSequence: 0 } });
      // The counter, not the entries left, is the bound.
      assert.equal(
        (await backend.read({ stream, afterSequence: 2, limit: 10 }))
          .lastSequence,
        2,
      );
      await assert.rejects(
        backend.read({ stream, afterSequence: 3, limit: 10 }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        backend.commit({ truncate: { stream, afterSequence: 3 } }),
        isCode('invalid_input'),
      );
    },
  ),
  sequences(
    'S6',
    'an absent stream reads empty at 0; a dropped stream loses its entries and marks and starts again at 1',
    async (harness) => {
      const backend = await open(harness);

      // A stream never appended to reads empty at 0.
      assert.deepEqual(
        await backend.read({ stream, afterSequence: 0, limit: 10 }),
        { entries: [], lastSequence: 0, truncations: [] },
      );
      await backend.commit({
        append: [
          { stream, events: ['1', '2', '3'] },
          { stream: other, events: ['kept'] },
        ],
      });
      await backend.commit({ truncate: { stream, afterSequence: 1 } });
      await backend.commit({
        dropStreams: [stream, 'conformance.thread.events/never'],
      });
      assert.deepEqual(
        await backend.read({ stream, afterSequence: 0, limit: 10 }),
        { entries: [], lastSequence: 0, truncations: [] },
      );
      assert.deepEqual(await sequenced(backend, other), [[1, 'kept']]);

      await backend.commit({ append: [{ stream, events: ['a'] }] });
      assert.deepEqual(await sequenced(backend, stream), [[1, 'a']]);

      // Dropping and appending in one batch: the append starts the stream over.
      await backend.commit({
        dropStreams: [stream],
        append: [{ stream, expectedSequence: 0, events: ['b'] }],
      });
      const restarted = await backend.read({
        stream,
        afterSequence: 0,
        limit: 10,
      });

      assert.deepEqual(
        restarted.entries.map(({ sequence, value }) => [sequence, value]),
        [[1, 'b']],
      );
      assert.equal(restarted.lastSequence, 1);
      assert.deepEqual(restarted.truncations, []);
    },
  ),
];
