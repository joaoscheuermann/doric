import assert from 'node:assert/strict';

import type { StorageBackend, StorageQuery } from 'bundle/contracts';

import { caseGroup } from './harness.js';
import { isCode, open, queryIds, walk } from './support.js';

const thread = 'conformance.thread/v1';
const put = (id: string, value: unknown) => ({ type: thread, id, value });

const declareThreads = (
  backend: StorageBackend,
  options: { readonly uniqueName?: boolean } = {},
) =>
  backend.declareType({
    type: thread,
    indexes: [
      { name: 'byProject', fields: ['projectId', 'createdAt'] },
      { name: 'byParent', fields: ['projectId', 'parentId'] },
      { name: 'byOwner', fields: ['owner.id'] },
      { name: 'byValue', fields: ['value'] },
      ...(options.uniqueName === true
        ? [{ name: 'byName', fields: ['name'], unique: true }]
        : []),
    ],
  });

type Query = Omit<StorageQuery, 'type' | 'limit'> & { limit?: number };

const ids = (backend: StorageBackend, query: Query) =>
  queryIds(backend, { type: thread, limit: 1000, ...query });

const queries = caseGroup('paginated queries');

export const queryCases = [
  queries(
    'Q1',
    'equality on leading fields matches null and absent fields alike',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend);
      await backend.commit({
        put: [
          put('root', { projectId: 'p1', owner: { id: 'u1' } }),
          put('nulled', { projectId: 'p1', parentId: null, owner: null }),
          put('child', { projectId: 'p1', parentId: 'root', owner: {} }),
          put('other', { projectId: 'p2', owner: { id: 'u1' } }),
        ],
      });

      assert.deepEqual(await ids(backend, { index: 'byParent', equals: [] }), [
        'nulled',
        'root',
        'child',
        'other',
      ]);
      assert.deepEqual(
        await ids(backend, { index: 'byParent', equals: ['p1', null] }),
        ['nulled', 'root'],
      );
      assert.deepEqual(
        await ids(backend, { index: 'byParent', equals: ['p1', 'root'] }),
        ['child'],
      );
      assert.deepEqual(
        await ids(backend, { index: 'byParent', equals: ['p1'] }),
        ['nulled', 'root', 'child'],
      );
      assert.deepEqual(
        await ids(backend, { index: 'byParent', equals: ['p3'] }),
        [],
      );
      // A dotted field reads nested values; a missing step is null.
      assert.deepEqual(
        await ids(backend, { index: 'byOwner', equals: ['u1'] }),
        ['other', 'root'],
      );
      assert.deepEqual(
        await ids(backend, { index: 'byOwner', equals: [null] }),
        ['child', 'nulled'],
      );

      // Only declared indexes, with at most their own fields, are queried.
      await assert.rejects(
        ids(backend, { index: 'undeclared', equals: [] }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        queryIds(backend, {
          type: 'conformance.undeclared/v1',
          index: 'byParent',
          equals: [],
          limit: 1,
        }),
        isCode('invalid_input'),
      );
      await assert.rejects(
        ids(backend, { index: 'byParent', equals: ['p1', null, 'extra'] }),
        isCode('invalid_input'),
      );
    },
  ),
  queries(
    'Q2',
    'a range on the field after the equality bounds it, ascending and descending',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend);
      await backend.commit({
        put: [5, 3, 1, 4, 2].map((day) =>
          put(`t${day}`, { projectId: 'p1', createdAt: `2026-10-0${day}` }),
        ),
      });
      await backend.commit({
        put: [put('elsewhere', { projectId: 'p2', createdAt: '2026-10-03' })],
      });

      const range = (bounds: StorageQuery['range'], order?: 'asc' | 'desc') =>
        ids(backend, {
          index: 'byProject',
          equals: ['p1'],
          range: bounds,
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
      assert.deepEqual(
        await ids(backend, { index: 'byProject', equals: ['p1'] }),
        ['t1', 't2', 't3', 't4', 't5'],
      );
      assert.deepEqual(
        await ids(backend, {
          index: 'byProject',
          equals: ['p1'],
          order: 'desc',
        }),
        ['t5', 't4', 't3', 't2', 't1'],
      );
      // A range on the first field, with no equality.
      assert.deepEqual(
        await ids(backend, {
          index: 'byProject',
          equals: [],
          range: { gt: 'p1' },
        }),
        ['elsewhere'],
      );
      // A range needs a field after the equality.
      await assert.rejects(
        ids(backend, {
          index: 'byValue',
          equals: ['x'],
          range: { gt: 'a' },
        }),
        isCode('invalid_input'),
      );
    },
  ),
  queries(
    'Q3',
    'items with equal keys are ordered by document ID, bytewise',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend);
      await backend.commit({
        put: ['tie-é', 'tie-a', 'tie-Z', 'tie-B', 'tie-'].map((id) =>
          put(id, { projectId: 'p1', createdAt: 'same' }),
        ),
      });

      const expected = ['tie-', 'tie-B', 'tie-Z', 'tie-a', 'tie-é'];

      assert.deepEqual(
        await ids(backend, { index: 'byProject', equals: ['p1', 'same'] }),
        expected,
      );
      assert.deepEqual(
        await ids(backend, {
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
    'keys order null < false < true < numbers < strings, numbers by value and strings bytewise',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend);

      const ordered: [string, unknown][] = [
        ['a-null', null],
        ['b-false', false],
        ['c-true', true],
        ['d-very-negative', -1e21],
        ['e-negative', -1.5],
        ['f-zero', 0],
        ['g-small', 0.25],
        ['h-two', 2],
        ['i-ten', 10],
        ['j-big', 1e21],
        ['k-empty', ''],
        ['l-upper', 'B'],
        ['m-lower', 'a'],
        ['n-longer', 'ab'],
        ['o-accent', 'é'],
        ['p-cjk', '日'],
      ];

      // Inserted in reverse so the order cannot come from insertion.
      await backend.commit({
        put: [...ordered].reverse().map(([id, value]) => put(id, { value })),
      });

      assert.deepEqual(
        await ids(backend, { index: 'byValue', equals: [] }),
        ordered.map(([id]) => id),
      );
      assert.deepEqual(
        await ids(backend, { index: 'byValue', equals: [], order: 'desc' }),
        ordered.map(([id]) => id).reverse(),
      );
      // Equality and ranges follow the same order.
      assert.deepEqual(
        await ids(backend, {
          index: 'byValue',
          equals: [],
          range: { gt: true },
        }),
        ordered.slice(3).map(([id]) => id),
      );
      assert.deepEqual(
        await ids(backend, {
          index: 'byValue',
          equals: [],
          range: { gte: 0, lt: '' },
        }),
        ['f-zero', 'g-small', 'h-two', 'i-ten', 'j-big'],
      );
      assert.deepEqual(await ids(backend, { index: 'byValue', equals: [2] }), [
        'h-two',
      ]);
      assert.deepEqual(
        await ids(backend, { index: 'byValue', equals: [false] }),
        ['b-false'],
      );
    },
  ),
  queries(
    'Q5',
    'pages of every limit walk each item exactly once, in both orders',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend);
      await backend.commit({
        put: Array.from({ length: 9 }, (_, index) =>
          put(`t${index}`, {
            projectId: 'p1',
            // Two items share each day, so pages also split ties.
            createdAt: `day-${Math.floor(index / 2)}`,
          }),
        ),
      });

      const query = { type: thread, index: 'byProject', equals: ['p1'] };
      const all = await ids(backend, { index: 'byProject', equals: ['p1'] });

      assert.equal(all.length, 9);
      assert.equal(new Set(all).size, 9);

      for (let limit = 1; limit <= 10; limit += 1) {
        assert.deepEqual(await walk(backend, query, limit), all, `${limit}`);
        assert.deepEqual(
          await walk(backend, { ...query, order: 'desc' }, limit),
          [...all].reverse(),
          `desc ${limit}`,
        );
      }

      // The last page carries no cursor; a malformed cursor is invalid_input.
      const whole = await backend.query({ ...query, limit: 9 });

      assert.equal(whole.items.length, 9);
      assert.equal(whole.cursor, undefined);
      await assert.rejects(
        backend.query({ ...query, limit: 1, cursor: 'not a cursor' }),
        isCode('invalid_input'),
      );
    },
  ),
  queries(
    'Q6',
    'writes between pages neither repeat nor skip the items still ahead',
    async (harness) => {
      const reader = await open(harness);
      const writer = await open(harness);

      await declareThreads(reader);
      await reader.commit({
        put: ['b', 'd', 'f', 'h', 'j'].map((day) =>
          put(day, { projectId: 'p1', createdAt: day }),
        ),
      });

      const query = { type: thread, index: 'byProject', equals: ['p1'] };
      const first = await reader.query({ ...query, limit: 2 });

      assert.deepEqual(
        first.items.map(({ id }) => id),
        ['b', 'd'],
      );
      assert.ok(first.cursor !== undefined);

      // Behind the cursor, ahead of it, a move from ahead to behind, and a delete.
      await writer.commit({
        put: [
          put('a', { projectId: 'p1', createdAt: 'a' }),
          put('e', { projectId: 'p1', createdAt: 'e' }),
          put('f', { projectId: 'p1', createdAt: 'c' }),
          put('elsewhere', { projectId: 'p2', createdAt: 'e' }),
        ],
        delete: [{ type: thread, id: 'h' }],
      });

      const second = await reader.query({
        ...query,
        limit: 1,
        cursor: first.cursor,
      });

      assert.deepEqual(
        second.items.map(({ id }) => id),
        ['e'],
      );

      // The document a cursor ended on may itself be gone.
      await writer.commit({ delete: [{ type: thread, id: 'e' }] });

      const rest = await reader.query({
        ...query,
        limit: 10,
        ...(second.cursor === undefined ? {} : { cursor: second.cursor }),
      });

      assert.deepEqual(
        rest.items.map(({ id }) => id),
        ['j'],
      );
      assert.equal(rest.cursor, undefined);
    },
  ),
  queries(
    'Q7',
    'a put that changes indexed fields moves the document between keys',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend);
      await backend.commit({
        put: [
          put('t1', { projectId: 'p1', createdAt: '1', value: 'old' }),
          put('t2', { projectId: 'p1', createdAt: '2', value: 'old' }),
        ],
      });
      await backend.commit({
        put: [put('t1', { projectId: 'p2', createdAt: '1', value: 'new' })],
      });

      assert.deepEqual(
        await ids(backend, { index: 'byProject', equals: ['p1'] }),
        ['t2'],
      );
      assert.deepEqual(
        await ids(backend, { index: 'byProject', equals: ['p2'] }),
        ['t1'],
      );
      assert.deepEqual(
        await ids(backend, { index: 'byValue', equals: ['old'] }),
        ['t2'],
      );

      // Dropping an indexed field moves the document to null.
      await backend.commit({ put: [put('t2', { projectId: 'p1' })] });
      assert.deepEqual(
        await ids(backend, { index: 'byValue', equals: [null] }),
        ['t2'],
      );

      const [item] = (
        await backend.query({
          type: thread,
          index: 'byValue',
          equals: ['new'],
          limit: 1,
        })
      ).items;

      // A query returns the whole stored document at its current revision.
      assert.deepEqual(item, {
        type: thread,
        id: 't1',
        revision: 2,
        value: { projectId: 'p2', createdAt: '1', value: 'new' },
      });
    },
  ),
  queries('Q8', 'a deleted document leaves every index', async (harness) => {
    const backend = await open(harness);

    await declareThreads(backend, { uniqueName: true });
    await backend.commit({
      put: [
        put('t1', { projectId: 'p1', createdAt: '1', name: 'one' }),
        put('t2', { projectId: 'p1', createdAt: '2', name: 'two' }),
      ],
    });
    await backend.commit({ delete: [{ type: thread, id: 't1' }] });

    assert.deepEqual(
      await ids(backend, { index: 'byProject', equals: ['p1'] }),
      ['t2'],
    );
    assert.deepEqual(
      await ids(backend, { index: 'byName', equals: ['one'] }),
      [],
    );
    // Its unique key is free again.
    await backend.commit({
      put: [put('t3', { projectId: 'p1', createdAt: '3', name: 'one' })],
    });
    assert.deepEqual(await ids(backend, { index: 'byName', equals: ['one'] }), [
      't3',
    ]);
  }),
  queries(
    'Q9',
    'a unique index violation is unique_conflict and the batch applies nothing',
    async (harness) => {
      const backend = await open(harness);

      await declareThreads(backend, { uniqueName: true });
      await backend.commit({ put: [put('t1', { name: 'taken' })] });
      await assert.rejects(
        backend.commit({
          put: [put('t2', { name: 'fresh' }), put('t3', { name: 'taken' })],
        }),
        isCode('unique_conflict', { type: thread, index: 'byName' }),
      );
      assert.equal(await backend.get({ type: thread, id: 't2' }), undefined);
      assert.deepEqual(await ids(backend, { index: 'byName', equals: [] }), [
        't1',
      ]);

      // Puts apply in batch order: t2 takes "taken" while t1 still holds it.
      await assert.rejects(
        backend.commit({
          put: [put('t2', { name: 'taken' }), put('t1', { name: 'moved' })],
        }),
        isCode('unique_conflict'),
      );
      // In the other order t1 has already moved away.
      await backend.commit({
        put: [put('t1', { name: 'moved' }), put('t2', { name: 'taken' })],
      });
      assert.deepEqual(
        await ids(backend, { index: 'byName', equals: ['taken'] }),
        ['t2'],
      );

      // A document may put the key it already holds.
      await backend.commit({ put: [put('t2', { name: 'taken', v: 2 })] });
      assert.equal(
        (await backend.get({ type: thread, id: 't2' }))?.revision,
        2,
      );
    },
  ),
  queries(
    'Q10',
    'declaring an index builds entries for stored documents, and a refused declaration changes nothing',
    async (harness) => {
      const backend = await open(harness);

      await backend.commit({
        put: [
          put('t1', { name: 'b', tag: 'x' }),
          put('t2', { name: 'a', tag: 'x' }),
          put('t3', { tag: 'y' }),
        ],
      });
      await backend.declareType({
        type: thread,
        indexes: [{ name: 'byName', fields: ['name'] }],
      });
      assert.deepEqual(await ids(backend, { index: 'byName', equals: [] }), [
        't3',
        't2',
        't1',
      ]);

      // An index declared over existing data that violates its uniqueness.
      await assert.rejects(
        backend.declareType({
          type: thread,
          indexes: [
            { name: 'byName', fields: ['name'] },
            { name: 'byTag', fields: ['tag'], unique: true },
          ],
        }),
        isCode('unique_conflict', { type: thread, index: 'byTag' }),
      );
      assert.deepEqual(await ids(backend, { index: 'byName', equals: ['a'] }), [
        't2',
      ]);
      await assert.rejects(
        ids(backend, { index: 'byTag', equals: [] }),
        isCode('invalid_input'),
      );
      // The previous declaration still holds for new puts.
      await backend.commit({ put: [put('t4', { name: 'c', tag: 'x' })] });
      assert.deepEqual(await ids(backend, { index: 'byName', equals: [] }), [
        't3',
        't2',
        't1',
        't4',
      ]);

      // Redeclaring an index over other fields rebuilds its entries.
      await backend.declareType({
        type: thread,
        indexes: [{ name: 'byName', fields: ['tag'] }],
      });
      assert.deepEqual(await ids(backend, { index: 'byName', equals: ['x'] }), [
        't1',
        't2',
        't4',
      ]);

      // One name twice in a declaration is invalid_input.
      await assert.rejects(
        backend.declareType({
          type: thread,
          indexes: [
            { name: 'same', fields: ['a'] },
            { name: 'same', fields: ['b'] },
          ],
        }),
        isCode('invalid_input'),
      );
      assert.deepEqual(await ids(backend, { index: 'byName', equals: ['y'] }), [
        't3',
      ]);
    },
  ),
];
