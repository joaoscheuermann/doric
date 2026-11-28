/**
 * Paginated queries over `storage/v2` (T4.3, T4.9, T4.23): Q1–Q9 as PF7
 * changes them (Q1's null-versus-absent for optional fields only, Q4 one
 * field per kind, an `int64` a string), and Q10 as a rebuild by
 * registration of a `withIndexes` variant, read with `ids`, whose
 * `unique_conflict` has the details `{ type, index, ids }` (OQ10).
 * Q1–Q4 are here; `paging.ts` holds Q5, Q6 and T4.9, `keyed.ts` Q7, Q8,
 * Q9, Q10 and T4.23.
 */
import assert from 'node:assert/strict';

import type { StorageQuery } from '../../client/types.js';
import { idsOf, type Lookup, thread, threadPut } from './fixtures.js';
import { caseGroup, type V2Case } from './harness.js';
import { keyedCases } from './keyed.js';
import { pagingCases } from './paging.js';
import { isCode } from './support.js';

const queries = caseGroup('paginated queries');

type ThreadLookup = Omit<Lookup, 'type'>;

const cases: readonly V2Case[] = [
  queries(
    'Q1',
    'equality on leading fields matches an unset optional field as null, and a field at its default as its value',
    async (harness) => {
      const storage = await harness.open();
      const ids = (query: ThreadLookup) =>
        idsOf(storage, { type: thread, ...query });

      await storage.commit({
        put: [
          threadPut('root', { projectId: 'p1', owner: { id: 'u1' } }),
          threadPut('top', { projectId: 'p1' }),
          threadPut('child', { projectId: 'p1', parentId: 'root', owner: {} }),
          threadPut('other', { projectId: 'p2', owner: { id: 'u1' } }),
        ],
      });

      assert.deepEqual(await ids({ index: 'byParent', equals: [] }), [
        'root',
        'top',
        'child',
        'other',
      ]);
      // `parentId` is optional: unset, it is null.
      assert.deepEqual(await ids({ index: 'byParent', equals: ['p1', null] }), [
        'root',
        'top',
      ]);
      assert.deepEqual(
        await ids({ index: 'byParent', equals: ['p1', 'root'] }),
        ['child'],
      );
      assert.deepEqual(await ids({ index: 'byParent', equals: ['p1'] }), [
        'root',
        'top',
        'child',
      ]);
      assert.deepEqual(await ids({ index: 'byParent', equals: ['p3'] }), []);
      // A dotted field reads nested values; a missing step is null, and an
      // owner present with its id at the default holds the empty string.
      assert.deepEqual(await ids({ index: 'byOwner', equals: ['u1'] }), [
        'other',
        'root',
      ]);
      assert.deepEqual(await ids({ index: 'byOwner', equals: [null] }), [
        'top',
      ]);
      assert.deepEqual(await ids({ index: 'byOwner', equals: [''] }), [
        'child',
      ]);

      // Only declared indexes, with at most their own fields, are queried.
      await assert.rejects(
        ids({ index: 'undeclared', equals: [] }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        ids({ index: 'byParent', equals: ['p1', null, 'extra'] }),
        isCode('invalid_input'),
      );
    },
  ),
  queries(
    'Q2',
    'a range on the field after the equality bounds it, ascending and descending',
    async (harness) => {
      const storage = await harness.open();
      const ids = (query: ThreadLookup) =>
        idsOf(storage, { type: thread, ...query });

      await storage.commit({
        put: [5, 3, 1, 4, 2].map((day) =>
          threadPut(`t${day}`, {
            projectId: 'p1',
            createdAt: `2026-10-0${day}`,
          }),
        ),
      });
      await storage.commit({
        put: [
          threadPut('elsewhere', { projectId: 'p2', createdAt: '2026-10-03' }),
        ],
      });

      const range = (bounds: StorageQuery['range'], order?: 'asc' | 'desc') =>
        ids({
          index: 'byProject',
          equals: ['p1'],
          ...(bounds === undefined ? {} : { range: bounds }),
          ...(order === undefined ? {} : { order }),
        });

      assert.deepEqual(await range({ gt: '2026-10-02' }), ['t3', 't4', 't5']);
      assert.deepEqual(await range({ gte: '2026-10-02' }), [
        't2',
        't3',
        't4',
        't5',
      ]);
      assert.deepEqual(await range({ lt: '2026-10-02' }), ['t1']);
      assert.deepEqual(await range({ lte: '2026-10-02' }), ['t1', 't2']);
      assert.deepEqual(await range({ gt: '2026-10-01', lte: '2026-10-04' }), [
        't2',
        't3',
        't4',
      ]);
      assert.deepEqual(
        await range({ gte: '2026-10-02', lt: '2026-10-04' }, 'desc'),
        ['t3', 't2'],
      );
      assert.deepEqual(await range({ gt: '2026-10-05' }), []);
      assert.deepEqual(await range(undefined), ['t1', 't2', 't3', 't4', 't5']);
      assert.deepEqual(await range(undefined, 'desc'), [
        't5',
        't4',
        't3',
        't2',
        't1',
      ]);
      // A range on the first field, with no equality.
      assert.deepEqual(
        await ids({ index: 'byProject', equals: [], range: { gt: 'p1' } }),
        ['elsewhere'],
      );
      // A range needs a field after the equality.
      await assert.rejects(
        ids({ index: 'byOwner', equals: ['x'], range: { gt: 'a' } }),
        isCode('invalid_input'),
      );
    },
  ),
  queries(
    'Q3',
    'items with equal keys are ordered by document id, bytewise',
    async (harness) => {
      const storage = await harness.open();
      const ids = (query: ThreadLookup) =>
        idsOf(storage, { type: thread, ...query });

      await storage.commit({
        put: ['tie-é', 'tie-a', 'tie-Z', 'tie-B', 'tie-'].map((id) =>
          threadPut(id, { projectId: 'p1', createdAt: 'same' }),
        ),
      });

      const expected = ['tie-', 'tie-B', 'tie-Z', 'tie-a', 'tie-é'];

      assert.deepEqual(
        await ids({ index: 'byProject', equals: ['p1', 'same'] }),
        expected,
      );
      assert.deepEqual(
        await ids({
          index: 'byProject',
          equals: ['p1', 'same'],
          order: 'desc',
        }),
        [...expected].reverse(),
      );
    },
  ),
  queries(
    'Q4',
    'keys order null < false < true < numbers < strings, one field per kind, numbers by value and strings bytewise',
    async (harness) => {
      const storage = await harness.open();
      const ids = (query: ThreadLookup) =>
        idsOf(storage, { type: thread, ...query });
      const counts: [string, number][] = [
        ['c01', -1e21],
        ['c02', -1.5],
        ['c03', 0],
        ['c04', 0.25],
        ['c05', 2],
        ['c06', 10],
        ['c07', 1e21],
      ];
      const flags: [string, boolean][] = [
        ['f1', false],
        ['f2', true],
      ];
      const names: [string, string][] = [
        ['s01', ''],
        ['s02', 'B'],
        ['s03', 'a'],
        ['s04', 'ab'],
        ['s05', 'é'],
        ['s06', '日'],
      ];
      const idsIn = (pairs: readonly [string, unknown][]) =>
        pairs.map(([id]) => id);

      // Each document sets one of the three fields; inserted in reverse so
      // the order cannot come from insertion.
      await storage.commit({
        put: [
          ...counts.map(([id, count]) => threadPut(id, { count })),
          ...flags.map(([id, flag]) => threadPut(id, { flag })),
          ...names.map(([id, name]) => threadPut(id, { name })),
        ].reverse(),
      });

      // Numbers by value; a bound of another kind bounds them too.
      assert.deepEqual(
        await ids({ index: 'byCount', equals: [], range: { gt: true } }),
        idsIn(counts),
      );
      assert.deepEqual(
        await ids({
          index: 'byCount',
          equals: [],
          range: { gt: true },
          order: 'desc',
        }),
        idsIn(counts).reverse(),
      );
      assert.deepEqual(
        await ids({ index: 'byCount', equals: [], range: { lt: '' } }),
        [...idsIn(flags), ...idsIn(names), ...idsIn(counts)],
      );
      assert.deepEqual(
        await ids({ index: 'byCount', equals: [], range: { gte: 0, lt: 10 } }),
        ['c03', 'c04', 'c05'],
      );
      assert.deepEqual(await ids({ index: 'byCount', equals: [2] }), ['c05']);
      assert.deepEqual(await ids({ index: 'byCount', equals: [null] }), [
        ...idsIn(flags),
        ...idsIn(names),
      ]);

      // Booleans: false before true, both after null and before numbers.
      assert.deepEqual(
        await ids({ index: 'byFlag', equals: [], range: { gte: false } }),
        idsIn(flags),
      );
      assert.deepEqual(await ids({ index: 'byFlag', equals: [false] }), ['f1']);
      assert.deepEqual(
        await ids({ index: 'byFlag', equals: [], range: { gte: 0 } }),
        [],
      );
      assert.deepEqual(
        await ids({ index: 'byFlag', equals: [], range: { lt: false } }),
        [...idsIn(counts), ...idsIn(names)],
      );

      // Strings bytewise in UTF-8, after every number.
      assert.deepEqual(
        await ids({ index: 'byName', equals: [], range: { gte: '' } }),
        idsIn(names),
      );
      assert.deepEqual(
        await ids({
          index: 'byName',
          equals: [],
          range: { gte: '' },
          order: 'desc',
        }),
        idsIn(names).reverse(),
      );
      assert.deepEqual(
        await ids({ index: 'byName', equals: [], range: { gt: 1e21 } }),
        idsIn(names),
      );
      assert.deepEqual(
        await ids({ index: 'byName', equals: [], range: { lte: true } }),
        [...idsIn(counts), ...idsIn(flags)],
      );
    },
  ),
];

/**
 * The cases, in run order, group `paginated queries`: Q1–Q4, then Q5, Q6
 * and T4.9, then Q7, Q8, Q9, Q10 and T4.23. None is skipped.
 */
export const queryCases: readonly V2Case[] = Object.freeze([
  ...cases,
  ...pagingCases,
  ...keyedCases,
]);
