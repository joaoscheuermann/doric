import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { codeOf, isCode, storageTest } from './support/storage.js';

// Streams with gaps, truncation marks, dropped streams, concurrent appends and
// the snapshot + cursor pattern (stage-3 evidence: sequence with gaps,
// snapshot + cursor, concurrency).

const stream = 'test.thread.events/t1';
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const values = async (backend: StorageBackend, afterSequence = 0) =>
  (await backend.read({ stream, afterSequence, limit: 1000 })).entries.map(
    ({ sequence, value }) => [sequence, value],
  );

storageTest(
  'appends number entries from 1 and are read after a cursor, with a protocol timestamp',
  async ({ open }) => {
    const backend = open();
    const empty = await backend.read({ stream, afterSequence: 0, limit: 10 });

    assert.deepEqual(empty, { entries: [], lastSequence: 0, truncations: [] });

    const before = Date.now();

    await backend.commit({
      append: [{ stream, events: [{ type: 'a' }, { type: 'b' }] }],
    });
    await backend.commit({ append: [{ stream, events: [{ type: 'c' }] }] });

    const page = await backend.read({ stream, afterSequence: 1, limit: 1 });

    assert.equal(page.lastSequence, 3);
    assert.deepEqual(
      page.entries.map(({ sequence, value }) => ({ sequence, value })),
      [{ sequence: 2, value: { type: 'b' } }],
    );

    const createdAt = page.entries[0]?.createdAt ?? '';

    assert.match(createdAt, iso);
    assert.ok(Date.parse(createdAt) >= before - 1000);
    assert.deepEqual(await values(backend, 3), []);
  },
);

storageTest(
  'two appends to one stream in one batch continue each other',
  async ({ open }) => {
    const backend = open();

    await backend.commit({
      append: [
        { stream, events: ['a'] },
        { stream: 'test.thread.events/t2', events: ['x'] },
        { stream, expectedSequence: 1, events: ['b', 'c'] },
      ],
    });
    assert.deepEqual(await values(backend), [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  },
);

storageTest(
  'reading after the last sequence is invalid_input',
  async ({ open }) => {
    const backend = open();

    await assert.rejects(
      backend.read({ stream, afterSequence: 1, limit: 10 }),
      isCode('invalid_input'),
    );
    await backend.commit({ append: [{ stream, events: ['a'] }] });
    await assert.rejects(
      backend.read({ stream, afterSequence: 2, limit: 10 }),
      isCode('invalid_input'),
    );
  },
);

storageTest(
  'truncation removes the tail, keeps the counter, and the next append leaves a gap',
  async ({ open }) => {
    const backend = open();

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
    // Reading across the gap.
    assert.deepEqual(await values(backend, 1), [
      [2, '2'],
      [6, '6'],
    ]);
    // A reader positioned in the removed tail still reads on.
    assert.deepEqual(await values(backend, 4), [[6, '6']]);

    await assert.rejects(
      backend.commit({ truncate: { stream, afterSequence: 7 } }),
      isCode('invalid_input'),
    );
  },
);

storageTest(
  'truncation marks reach exactly the readers that may hold removed entries',
  async ({ open }) => {
    const backend = open();

    await backend.commit({
      append: [{ stream, events: ['1', '2', '3', '4', '5'] }],
    });
    // The mark records the counter at the end of the batch, appends included.
    await backend.commit({
      truncate: { stream, afterSequence: 2 },
      append: [{ stream, events: ['6'] }],
    });

    const marksFor = async (afterSequence: number) =>
      (await backend.read({ stream, afterSequence, limit: 10 })).truncations;
    const mark = { afterSequence: 2, atSequence: 6 };

    assert.deepEqual(await marksFor(0), []);
    assert.deepEqual(await marksFor(2), []);
    assert.deepEqual(await marksFor(3), [mark]);
    assert.deepEqual(await marksFor(6), [mark]);

    // A later truncation adds its own mark beside the first.
    await backend.commit({ truncate: { stream, afterSequence: 1 } });
    assert.deepEqual(await marksFor(3), [
      mark,
      { afterSequence: 1, atSequence: 6 },
    ]);
    assert.deepEqual(await marksFor(2), [{ afterSequence: 1, atSequence: 6 }]);
  },
);

storageTest(
  'a dropped stream loses its entries and marks and starts again at 1',
  async ({ open }) => {
    const backend = open();

    await backend.commit({ append: [{ stream, events: ['1', '2', '3'] }] });
    await backend.commit({ truncate: { stream, afterSequence: 1 } });
    await backend.commit({ dropStreams: [stream] });
    assert.deepEqual(
      await backend.read({ stream, afterSequence: 0, limit: 10 }),
      {
        entries: [],
        lastSequence: 0,
        truncations: [],
      },
    );

    // Dropping and appending in one batch: the append starts the stream over.
    await backend.commit({ append: [{ stream, events: ['a'] }] });
    await backend.commit({
      dropStreams: [stream],
      append: [{ stream, expectedSequence: 0, events: ['b'] }],
    });
    assert.deepEqual(await values(backend), [[1, 'b']]);
  },
);

storageTest(
  'concurrent appends with the same expected sequence: exactly one wins',
  async ({ open }) => {
    const first = open();
    const second = open();

    await first.commit({ append: [{ stream, events: ['seed'] }] });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? first : second).commit({
          append: [{ stream, expectedSequence: 1, events: [index] }],
        }),
      ),
    );
    const outcomes = results.map(codeOf);

    assert.equal(outcomes.filter((code) => code === 'ok').length, 1);
    assert.equal(
      outcomes.filter((code) => code === 'sequence_conflict').length,
      9,
    );
    assert.equal(
      (await first.read({ stream, afterSequence: 0, limit: 10 })).lastSequence,
      2,
    );
  },
);

storageTest(
  '50 concurrent appends without an expected sequence get contiguous, unique sequences',
  async ({ open }) => {
    const first = open();
    const second = open();

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (index % 2 === 0 ? first : second).commit({
          append: [{ stream, events: [index] }],
        }),
      ),
    );

    const entries = await values(first);

    assert.deepEqual(
      entries.map(([sequence]) => sequence),
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    assert.deepEqual(
      entries
        .map(([, value]) => value)
        .sort((left, right) => Number(left) - Number(right)),
      Array.from({ length: 50 }, (_, index) => index),
    );
  },
);

storageTest(
  'a snapshot holding its cursor plus a read after it sees every entry exactly once',
  async ({ open }) => {
    const snapshot = { type: 'test.thread/v1', id: 't1' };
    const folders = [open(), open()];
    const appender = open();

    await folders[0]?.commit({
      put: [{ ...snapshot, value: { cursor: 0, seen: [] } }],
    });

    // Folders append one event and fold it into the snapshot in the same
    // commit, retrying on conflicts; the appender appends without folding.
    const fold = async (backend: StorageBackend, event: string) => {
      for (;;) {
        const current = await backend.get(snapshot);
        const state = current?.value as { cursor: number; seen: string[] };
        const page = await backend.read({
          stream,
          afterSequence: state.cursor,
          limit: 1000,
        });
        const unseen = page.entries.map(({ value }) => value as string);

        try {
          await backend.commit({
            expect: [{ ...snapshot, revision: current?.revision ?? 0 }],
            put: [
              {
                ...snapshot,
                value: {
                  cursor: page.lastSequence + 1,
                  seen: [...state.seen, ...unseen, event],
                },
              },
            ],
            append: [
              { stream, expectedSequence: page.lastSequence, events: [event] },
            ],
          });

          return;
        } catch (error) {
          const code = codeOf({ status: 'rejected', reason: error });

          if (code !== 'revision_conflict' && code !== 'sequence_conflict') {
            throw error;
          }
        }
      }
    };
    const events = Array.from({ length: 12 }, (_, index) => `f${index}`);
    const plain = Array.from({ length: 12 }, (_, index) => `p${index}`);

    await Promise.all([
      ...events.map((event, index) =>
        fold(folders[index % 2] as StorageBackend, event),
      ),
      ...plain.map((event) =>
        appender.commit({ append: [{ stream, events: [event] }] }),
      ),
    ]);

    const reader = open();
    const state = (await reader.get(snapshot))?.value as {
      cursor: number;
      seen: string[];
    };
    const rest: string[] = [];
    let after = state.cursor;

    for (;;) {
      const page = await reader.read({
        stream,
        afterSequence: after,
        limit: 5,
      });

      if (page.entries.length === 0) {
        break;
      }

      rest.push(...page.entries.map(({ value }) => value as string));
      after = page.entries.at(-1)?.sequence ?? after;
    }

    const all = [...state.seen, ...rest];

    assert.equal(new Set(all).size, all.length);
    assert.deepEqual([...all].sort(), [...events, ...plain].sort());
  },
);
