import assert from 'node:assert/strict';

import type { StorageBackend, StorageQuery } from 'bundle/contracts';

import { isCode, storageTest } from './support/storage.js';

// Paginated queries over declared indexes (stage-3 evidence: paginated
// queries): equality including null, ranges, both orders, ties by ID,
// cursors under concurrent writes, and the cross-type key order.

const thread = 'test.thread/v1';
const put = (id: string, value: unknown) => ({ type: thread, id, value });

const declare = (backend: StorageBackend) =>
  backend.declareType({
    type: thread,
    indexes: [
      { name: 'byProject', fields: ['projectId', 'createdAt'] },
      { name: 'byParent', fields: ['projectId', 'parentId'] },
      { name: 'byValue', fields: ['value'] },
    ],
  });

const ids = async (
  backend: StorageBackend,
  query: Omit<StorageQuery, 'type' | 'limit'> & { limit?: number },
) =>
  (await backend.query({ type: thread, limit: 100, ...query })).items.map(
    ({ id }) => id,
  );

/** Walks every page with this limit and returns the IDs in page order. */
const walk = async (
  backend: StorageBackend,
  query: Omit<StorageQuery, 'type' | 'limit' | 'cursor'>,
  limit: number,
) => {
  const seen: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await backend.query({
      type: thread,
      ...query,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });

    assert.ok(page.items.length <= limit);
    seen.push(...page.items.map(({ id }) => id));
    cursor = page.cursor;
  } while (cursor !== undefined);

  return seen;
};

storageTest(
  'equality on leading fields matches null and absent fields alike',
  async ({ open }) => {
    const backend = open();

    await declare(backend);
    await backend.commit({
      put: [
        put('root', { projectId: 'p1' }),
        put('nulled', { projectId: 'p1', parentId: null }),
        put('child', { projectId: 'p1', parentId: 'root' }),
        put('other', { projectId: 'p2' }),
      ],
    });

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
  },
);

storageTest(
  'a range on the field after the equality bounds it, in both orders',
  async ({ open }) => {
    const backend = open();

    await declare(backend);
    await backend.commit({
      put: [1, 2, 3, 4, 5].map((day) =>
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
    assert.deepEqual(
      await range({ gt: '2026-10-01', lte: '2026-10-04' }, 'desc'),
      ['t4', 't3', 't2'],
    );
    assert.deepEqual(
      await ids(backend, { index: 'byProject', equals: ['p1'], order: 'desc' }),
      ['t5', 't4', 't3', 't2', 't1'],
    );
  },
);

storageTest(
  'keys order null < false < true < numbers < strings, strings bytewise, ties by ID',
  async ({ open }) => {
    const backend = open();

    await declare(backend);

    const ordered: [string, unknown][] = [
      ['a-null', null],
      ['b-false', false],
      ['c-true', true],
      ['d-negative', -1.5],
      ['e-zero', 0],
      ['f-big', 1e21],
      ['g-empty', ''],
      ['h-upper', 'B'],
      ['i-lower', 'a'],
      ['j-accent', 'é'],
    ];

    // Inserted in reverse so the order cannot come from insertion.
    await backend.commit({
      put: [...ordered].reverse().map(([id, value]) => put(id, { value })),
    });
    // Equal keys break ties by document ID bytewise ('Z' < 'a').
    await backend.commit({
      put: [put('tie-a', { value: 'éé' }), put('tie-Z', { value: 'éé' })],
    });

    assert.deepEqual(await ids(backend, { index: 'byValue', equals: [] }), [
      ...ordered.map(([id]) => id),
      'tie-Z',
      'tie-a',
    ]);
    assert.deepEqual(
      await ids(backend, { index: 'byValue', equals: [], order: 'desc' }),
      ['tie-a', 'tie-Z', ...ordered.map(([id]) => id).reverse()],
    );
  },
);

storageTest(
  'pages of every size walk each item exactly once, in both orders',
  async ({ open }) => {
    const backend = open();

    await declare(backend);
    await backend.commit({
      put: Array.from({ length: 9 }, (_, index) =>
        put(`t${index}`, {
          projectId: 'p1',
          // Two items share each day, so pages also split ties.
          createdAt: `day-${Math.floor(index / 2)}`,
        }),
      ),
    });

    const all = await ids(backend, { index: 'byProject', equals: ['p1'] });

    assert.equal(all.length, 9);

    for (let limit = 1; limit <= 10; limit += 1) {
      assert.deepEqual(
        await walk(backend, { index: 'byProject', equals: ['p1'] }, limit),
        all,
        `limit ${limit}`,
      );
      assert.deepEqual(
        await walk(
          backend,
          { index: 'byProject', equals: ['p1'], order: 'desc' },
          limit,
        ),
        [...all].reverse(),
        `desc limit ${limit}`,
      );
    }
  },
);

storageTest(
  'writes between pages neither repeat nor skip the items still ahead',
  async ({ open }) => {
    const backend = open();
    const writer = open();

    await declare(backend);
    await backend.commit({
      put: ['b', 'd', 'f', 'h'].map((day) =>
        put(day, { projectId: 'p1', createdAt: day }),
      ),
    });

    const first = await backend.query({
      type: thread,
      index: 'byProject',
      equals: ['p1'],
      limit: 2,
    });

    assert.deepEqual(
      first.items.map(({ id }) => id),
      ['b', 'd'],
    );

    // Behind the cursor, ahead of it, a move from ahead to behind, and a delete.
    await writer.commit({
      put: [
        put('a', { projectId: 'p1', createdAt: 'a' }),
        put('e', { projectId: 'p1', createdAt: 'e' }),
        put('f', { projectId: 'p1', createdAt: 'c' }),
      ],
      delete: [{ type: thread, id: 'h' }],
    });

    const rest = await backend.query({
      type: thread,
      index: 'byProject',
      equals: ['p1'],
      limit: 10,
      ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
    });

    assert.deepEqual(
      rest.items.map(({ id }) => id),
      ['e'],
    );
    assert.equal(rest.cursor, undefined);
  },
);

storageTest(
  'a query names a declared index, takes its leading fields, and a valid cursor',
  async ({ open }) => {
    const backend = open();

    await assert.rejects(
      backend.query({ type: thread, index: 'byProject', equals: [], limit: 1 }),
      isCode('invalid_input'),
    );
    await declare(backend);
    await assert.rejects(
      backend.query({
        type: thread,
        index: 'byProject',
        equals: ['p1', 'x', 'extra'],
        limit: 1,
      }),
      isCode('invalid_input'),
    );
    await assert.rejects(
      backend.query({
        type: thread,
        index: 'byValue',
        equals: ['x'],
        range: { gt: 'a' },
        limit: 1,
      }),
      isCode('invalid_input'),
    );
    await assert.rejects(
      backend.query({
        type: thread,
        index: 'byValue',
        equals: [],
        limit: 1,
        cursor: 'not a cursor',
      }),
      isCode('invalid_input'),
    );
  },
);

storageTest('values come back as stored, unvalidated', async ({ open }) => {
  const backend = open();

  await declare(backend);
  await backend.commit({
    put: [put('t1', { projectId: 'p1', extra: { deep: [1, 'two', null] } })],
  });

  const [item] = (
    await backend.query({
      type: thread,
      index: 'byProject',
      equals: ['p1'],
      limit: 1,
    })
  ).items;

  assert.deepEqual(item, {
    type: thread,
    id: 't1',
    revision: 1,
    value: { projectId: 'p1', extra: { deep: [1, 'two', null] } },
  });
});
