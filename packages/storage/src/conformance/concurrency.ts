import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { type ConformanceHarness, caseGroup } from './harness.js';
import { open, queryIds, sequenced, tally, upTo } from './support.js';

const note = 'conformance.note/v1';
const key = (id: string) => ({ type: note, id });
const put = (id: string, value: unknown) => ({ type: note, id, value });
const stream = 'conformance.note.events/n1';

/** Two instances over one store, so calls race across connections too. */
const pair = async (
  harness: ConformanceHarness,
): Promise<(index: number) => StorageBackend> => {
  const instances = [await open(harness), await open(harness)];

  return (index) => instances[index % 2] as StorageBackend;
};

const concurrency = caseGroup('concurrency');

export const concurrencyCases = [
  concurrency(
    'C1',
    'of 20 concurrent commits expecting the same revision, exactly one succeeds',
    async (harness) => {
      const backend = await pair(harness);

      await backend(0).commit({ put: [put('n1', { by: 'seed' })] });

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) =>
          backend(index).commit({
            expect: [{ ...key('n1'), revision: 1 }],
            put: [put('n1', { by: index })],
          }),
        ),
      );

      assert.deepEqual(tally(results), { ok: 1, revision_conflict: 19 });

      const winner = results.findIndex(
        (result) => result.status === 'fulfilled',
      );

      assert.deepEqual(await backend(1).get(key('n1')), {
        ...key('n1'),
        revision: 2,
        value: { by: winner },
      });

      // Concurrent creates expecting the document absent: one wins as well.
      const creates = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          backend(index).commit({
            expect: [{ ...key('n2'), revision: 0 }],
            put: [put('n2', { by: index })],
          }),
        ),
      );

      assert.deepEqual(tally(creates), { ok: 1, revision_conflict: 11 });
      assert.equal((await backend(0).get(key('n2')))?.revision, 1);
    },
  ),
  concurrency(
    'C2',
    'of concurrent appends with the same expected sequence, exactly one succeeds',
    async (harness) => {
      const backend = await pair(harness);

      await backend(0).commit({ append: [{ stream, events: ['seed'] }] });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, index) =>
          backend(index).commit({
            append: [{ stream, expectedSequence: 1, events: [index] }],
          }),
        ),
      );

      assert.deepEqual(tally(results), { ok: 1, sequence_conflict: 9 });

      const winner = results.findIndex(
        (result) => result.status === 'fulfilled',
      );

      assert.deepEqual(await sequenced(backend(1), stream), [
        [1, 'seed'],
        [2, winner],
      ]);
    },
  ),
  concurrency(
    'C3',
    '50 concurrent appends without an expected sequence get contiguous, unique sequences',
    async (harness) => {
      const backend = await pair(harness);

      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          backend(index).commit({ append: [{ stream, events: [index] }] }),
        ),
      );

      const entries = await sequenced(backend(0), stream);

      assert.deepEqual(
        entries.map(([sequence]) => sequence),
        upTo(50),
      );
      assert.deepEqual(
        entries
          .map(([, value]) => value as number)
          .sort((left, right) => left - right),
        upTo(50).map((value) => value - 1),
      );
      assert.equal(
        (await backend(1).read({ stream, afterSequence: 0, limit: 1 }))
          .lastSequence,
        50,
      );
    },
  ),
  concurrency(
    'C4',
    'concurrent puts to distinct documents all succeed; of distinct documents claiming one unique key, one does',
    async (harness) => {
      const backend = await pair(harness);

      await backend(0).declareType({
        type: note,
        indexes: [
          { name: 'byTag', fields: ['tag'] },
          { name: 'byTitle', fields: ['title'], unique: true },
        ],
      });

      const ids = Array.from({ length: 30 }, (_, index) => `d${index}`);
      const results = await Promise.allSettled(
        ids.map((id, index) =>
          backend(index).commit({ put: [put(id, { title: id, tag: 'all' })] }),
        ),
      );

      assert.deepEqual(tally(results), { ok: 30 });
      assert.deepEqual(
        (
          await queryIds(backend(1), {
            type: note,
            index: 'byTag',
            equals: ['all'],
            limit: 100,
          })
        ).sort(),
        [...ids].sort(),
      );

      const claims = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) =>
          backend(index).commit({
            put: [put(`claim${index}`, { title: 'only one', tag: 'claim' })],
          }),
        ),
      );

      assert.deepEqual(tally(claims), { ok: 1, unique_conflict: 11 });

      const winner = claims.findIndex(
        (result) => result.status === 'fulfilled',
      );

      assert.deepEqual(
        await queryIds(backend(0), {
          type: note,
          index: 'byTitle',
          equals: ['only one'],
          limit: 100,
        }),
        [`claim${winner}`],
      );
      assert.deepEqual(
        await queryIds(backend(0), {
          type: note,
          index: 'byTag',
          equals: ['claim'],
          limit: 100,
        }),
        [`claim${winner}`],
      );
    },
  ),
];
