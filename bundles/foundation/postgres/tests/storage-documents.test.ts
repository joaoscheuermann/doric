import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { codeOf, isCode, storageTest } from './support/storage.js';

// Documents, revisions, concurrency and atomic failure of
// `storage.backend/v1` on PostgreSQL (stage-3 evidence: concurrency,
// revision conflicts, commit failure).

const note = 'test.note/v1';
const key = (id: string) => ({ type: note, id });
const put = (id: string, value: unknown) => ({ type: note, id, value });
const stream = 'test.note.events/n1';

const declareNotes = (backend: StorageBackend) =>
  backend.declareType({
    type: note,
    indexes: [
      { name: 'byTitle', fields: ['title'], unique: true },
      { name: 'byTag', fields: ['tag'] },
    ],
  });

/** Everything a failed batch could have left behind, read through the contract. */
const traces = async (backend: StorageBackend) => ({
  documents: await Promise.all(
    ['n1', 'n2', 'n3'].map(
      async (id) => (await backend.get(key(id)))?.revision,
    ),
  ),
  titles: (
    await backend.query({ type: note, index: 'byTitle', equals: [], limit: 10 })
  ).items.map(({ id }) => id),
  stream: await backend.read({ stream, afterSequence: 0, limit: 10 }),
  feed: (await backend.feed({ after: 0, limit: 100 })).commits.map(
    ({ position }) => position,
  ),
});

storageTest(
  'a put document reads back as stored, at revision 1 and then one more per put',
  async ({ open }) => {
    const backend = open();

    assert.equal(await backend.get(key('n1')), undefined);
    await backend.commit({
      put: [put('n1', { title: 'one', nested: [1, null] })],
    });
    assert.deepEqual(await backend.get(key('n1')), {
      type: note,
      id: 'n1',
      revision: 1,
      value: { title: 'one', nested: [1, null] },
    });

    await backend.commit({ put: [put('n1', { title: 'two' })] });
    await backend.commit({ put: [put('n1', 'a string')] });
    assert.deepEqual(await backend.get(key('n1')), {
      type: note,
      id: 'n1',
      revision: 3,
      value: 'a string',
    });

    // Two puts of one document in one batch are two revisions; the last value wins.
    await backend.commit({ put: [put('n1', 1), put('n1', 2)] });
    assert.deepEqual(await backend.get(key('n1')), {
      type: note,
      id: 'n1',
      revision: 5,
      value: 2,
    });

    await backend.commit({ delete: [key('n1')] });
    assert.equal(await backend.get(key('n1')), undefined);

    // A document created again starts over at revision 1.
    await backend.commit({ put: [put('n1', { title: 'again' })] });
    assert.equal((await backend.get(key('n1')))?.revision, 1);
  },
);

storageTest(
  'a stale expect is revision_conflict with its details, and nothing of the batch applies',
  async ({ open }) => {
    const backend = open();

    await backend.commit({ put: [put('n1', { v: 1 })] });
    await assert.rejects(
      backend.commit({
        expect: [{ ...key('n1'), revision: 2 }],
        put: [put('n1', { v: 2 }), put('n2', { v: 1 })],
      }),
      isCode('revision_conflict', {
        type: note,
        id: 'n1',
        expected: 2,
        actual: 1,
      }),
    );
    assert.deepEqual((await backend.get(key('n1')))?.value, { v: 1 });
    assert.equal(await backend.get(key('n2')), undefined);

    // After a re-read, the same write with the current revision succeeds.
    const current = await backend.get(key('n1'));

    await backend.commit({
      expect: [{ ...key('n1'), revision: current?.revision ?? 0 }],
      put: [put('n1', { v: 2 })],
    });
    assert.deepEqual(await backend.get(key('n1')), {
      ...key('n1'),
      revision: 2,
      value: { v: 2 },
    });
  },
);

storageTest(
  'expect revision 0 passes only while the document is absent',
  async ({ open }) => {
    const backend = open();

    await backend.commit({
      expect: [{ ...key('n1'), revision: 0 }],
      put: [put('n1', 'created')],
    });
    await assert.rejects(
      backend.commit({
        expect: [{ ...key('n1'), revision: 0 }],
        put: [put('n1', 'twice')],
      }),
      isCode('revision_conflict', { ...key('n1'), expected: 0, actual: 1 }),
    );
    assert.deepEqual((await backend.get(key('n1')))?.value, 'created');

    // An expect for an absent document that is not 0 fails with actual 0.
    await assert.rejects(
      backend.commit({ expect: [{ ...key('n2'), revision: 1 }] }),
      isCode('revision_conflict', { ...key('n2'), expected: 1, actual: 0 }),
    );
  },
);

storageTest(
  'one stale document among several expected leaves every document unchanged',
  async ({ open }) => {
    const backend = open();

    await backend.commit({ put: [put('n1', 'a'), put('n2', 'b')] });
    await backend.commit({ put: [put('n2', 'b2')] });
    await assert.rejects(
      backend.commit({
        expect: [
          { ...key('n1'), revision: 1 },
          { ...key('n2'), revision: 1 },
        ],
        put: [put('n1', 'x'), put('n2', 'y')],
      }),
      isCode('revision_conflict'),
    );
    assert.deepEqual(
      [
        (await backend.get(key('n1')))?.value,
        (await backend.get(key('n2')))?.value,
      ],
      ['a', 'b2'],
    );
  },
);

storageTest(
  'of 20 concurrent commits expecting the same revision, exactly one succeeds',
  async ({ open }) => {
    const first = open();
    const second = open();

    await first.commit({ put: [put('n1', { by: 'seed' })] });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).commit({
          expect: [{ ...key('n1'), revision: 1 }],
          put: [put('n1', { by: index })],
        }),
      ),
    );
    const outcomes = results.map(codeOf);

    assert.equal(outcomes.filter((code) => code === 'ok').length, 1);
    assert.equal(
      outcomes.filter((code) => code === 'revision_conflict').length,
      19,
    );
    assert.equal((await first.get(key('n1')))?.revision, 2);
  },
);

storageTest(
  'of concurrent creates expecting the document absent, exactly one succeeds',
  async ({ open }) => {
    const first = open();
    const second = open();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).commit({
          expect: [{ ...key('n1'), revision: 0 }],
          put: [put('n1', { by: index })],
        }),
      ),
    );
    const outcomes = results.map(codeOf);

    assert.equal(outcomes.filter((code) => code === 'ok').length, 1);
    assert.equal(
      outcomes.filter((code) => code === 'revision_conflict').length,
      11,
    );
    assert.equal((await second.get(key('n1')))?.revision, 1);
  },
);

storageTest(
  'concurrent puts to distinct documents all succeed',
  async ({ open }) => {
    const first = open();
    const second = open();

    await declareNotes(first);

    const ids = Array.from({ length: 30 }, (_, index) => `d${index}`);
    const results = await Promise.allSettled(
      ids.map((id, index) =>
        (index % 2 === 0 ? first : second).commit({
          put: [put(id, { title: id, tag: 'all' })],
        }),
      ),
    );

    assert.deepEqual(
      results.map(codeOf),
      ids.map(() => 'ok'),
    );
    assert.equal(
      (
        await first.query({
          type: note,
          index: 'byTag',
          equals: ['all'],
          limit: 100,
        })
      ).items.length,
      30,
    );
  },
);

storageTest(
  'of concurrent puts claiming one unique key for distinct documents, exactly one succeeds',
  async ({ open }) => {
    const first = open();
    const second = open();

    await declareNotes(first);

    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).commit({
          put: [put(`claim${index}`, { title: 'only one' })],
        }),
      ),
    );
    const outcomes = results.map(codeOf);

    assert.equal(outcomes.filter((code) => code === 'ok').length, 1);
    assert.equal(
      outcomes.filter((code) => code === 'unique_conflict').length,
      11,
    );
  },
);

storageTest(
  'a unique index violation raised mid-batch rolls the whole batch back',
  async ({ open }) => {
    const backend = open();

    await declareNotes(backend);
    await backend.commit({ put: [put('n1', { title: 'taken', tag: 't' })] });

    const before = await traces(backend);

    await assert.rejects(
      backend.commit({
        put: [
          put('n2', { title: 'fresh', tag: 't' }),
          put('n3', { title: 'taken' }),
        ],
        append: [{ stream, events: ['e1'] }],
      }),
      isCode('unique_conflict', { type: note, index: 'byTitle' }),
    );
    assert.deepEqual(await traces(backend), before);

    // Moving a document's key away frees it for another document.
    await backend.commit({
      put: [put('n1', { title: 'moved' }), put('n3', { title: 'taken' })],
    });
    assert.deepEqual(
      (
        await backend.query({
          type: note,
          index: 'byTitle',
          equals: ['taken'],
          limit: 10,
        })
      ).items.map(({ id }) => id),
      ['n3'],
    );
  },
);

storageTest(
  'a unique key another document still holds when the put runs is a conflict',
  async ({ open }) => {
    const backend = open();

    await declareNotes(backend);
    await backend.commit({ put: [put('n1', { title: 'a' })] });

    // Puts apply in batch order: n2 takes "a" while n1 still holds it.
    await assert.rejects(
      backend.commit({
        put: [put('n2', { title: 'a' }), put('n1', { title: 'b' })],
      }),
      isCode('unique_conflict'),
    );

    // In the other order n1 has already moved away.
    await backend.commit({
      put: [put('n1', { title: 'b' }), put('n2', { title: 'a' })],
    });
    assert.equal((await backend.get(key('n2')))?.revision, 1);
  },
);

storageTest(
  'an object in an indexed field is invalid_index_value and nothing applies',
  async ({ open }) => {
    const backend = open();

    await declareNotes(backend);

    const before = await traces(backend);

    await assert.rejects(
      backend.commit({
        put: [put('n1', { title: 'ok' }), put('n2', { title: { no: 1 } })],
      }),
      isCode('invalid_index_value'),
    );
    assert.deepEqual(await traces(backend), before);
  },
);

storageTest(
  'each commit failure leaves no document, entry, mark, feed entry or sequence behind',
  async ({ open }) => {
    const backend = open({ limits: { maxBatch: 6 } });

    await declareNotes(backend);
    await backend.commit({
      put: [put('n1', { title: 'one' })],
      append: [{ stream, events: ['e1', 'e2', 'e3'] }],
    });

    const before = await traces(backend);
    const failures: [string, Parameters<StorageBackend['commit']>[0]][] = [
      [
        'revision_conflict',
        {
          put: [put('n2', { title: 'two' })],
          append: [{ stream, events: ['x'] }],
          truncate: { stream, afterSequence: 1 },
          expect: [{ ...key('n1'), revision: 9 }],
        },
      ],
      [
        'sequence_conflict',
        {
          put: [put('n2', { title: 'two' })],
          truncate: { stream, afterSequence: 1 },
          append: [{ stream, expectedSequence: 1, events: ['x'] }],
        },
      ],
      [
        'unique_conflict',
        {
          delete: [key('n1')],
          put: [put('n2', { title: 'two' }), put('n3', { title: 'two' })],
          append: [{ stream, events: ['x'] }],
        },
      ],
      [
        'limit_exceeded',
        {
          put: [put('n2', 'a'), put('n3', 'b')],
          append: [{ stream, events: ['1', '2', '3', '4', '5'] }],
        },
      ],
      ['invalid_input', {}],
      ['invalid_input', { truncate: { stream, afterSequence: 4 } }],
    ];

    for (const [code, batch] of failures) {
      await assert.rejects(backend.commit(batch), isCode(code));
      assert.deepEqual(await traces(backend), before, code);
    }

    // The stream's next append still continues the counter.
    await backend.commit({ append: [{ stream, events: ['e4'] }] });
    assert.equal(
      (await backend.read({ stream, afterSequence: 3, limit: 10 })).entries[0]
        ?.sequence,
      4,
    );
  },
);

storageTest(
  'a document of an undeclared type is readable, and declaring an index never deletes data',
  async ({ open }) => {
    const backend = open();

    await backend.commit({
      put: [
        put('n1', { title: 'b', tag: 'x' }),
        put('n2', { title: 'a', tag: 'x' }),
        put('n3', { tag: 'y' }),
      ],
    });
    assert.equal((await backend.get(key('n1')))?.revision, 1);

    // Declaring an index builds entries for the documents already stored.
    await declareNotes(backend);
    assert.deepEqual(
      (
        await backend.query({
          type: note,
          index: 'byTitle',
          equals: [],
          limit: 10,
        })
      ).items.map(({ id }) => id),
      ['n3', 'n2', 'n1'],
    );

    // A declaration whose unique index the stored data violates is refused
    // and leaves the previous one in force.
    await assert.rejects(
      backend.declareType({
        type: note,
        indexes: [{ name: 'byTag', fields: ['tag'], unique: true }],
      }),
      isCode('unique_conflict', { type: note, index: 'byTag' }),
    );
    assert.equal(
      (
        await backend.query({
          type: note,
          index: 'byTitle',
          equals: ['a'],
          limit: 10,
        })
      ).items[0]?.id,
      'n2',
    );

    // Dropping every index keeps the documents.
    await backend.declareType({ type: note, indexes: [] });
    await assert.rejects(
      backend.query({ type: note, index: 'byTitle', equals: [], limit: 10 }),
      isCode('invalid_input'),
    );
    assert.deepEqual(
      await Promise.all(
        ['n1', 'n2', 'n3'].map(
          async (id) => (await backend.get(key(id)))?.revision,
        ),
      ),
      [1, 1, 1],
    );
  },
);

storageTest(
  'a declaration naming one index twice is invalid_input',
  async ({ open }) => {
    const backend = open();

    await assert.rejects(
      backend.declareType({
        type: note,
        indexes: [
          { name: 'same', fields: ['a'] },
          { name: 'same', fields: ['b'] },
        ],
      }),
      isCode('invalid_input'),
    );
  },
);

storageTest(
  'limits are inclusive: a batch, a document or an event over them is limit_exceeded',
  async ({ open }) => {
    const defaults = await open().capabilities();

    assert.deepEqual(defaults, {
      maxBatch: 10_000,
      maxDocumentBytes: 268_435_455,
      maxAppendBytes: 268_435_455,
    });

    const backend = open({
      limits: { maxBatch: 2, maxDocumentBytes: 7, maxAppendBytes: 5 },
    });

    assert.deepEqual(await backend.capabilities(), {
      maxBatch: 2,
      maxDocumentBytes: 7,
      maxAppendBytes: 5,
    });
    await backend.commit({ put: [put('n1', 'x'), put('n2', 'y')] });
    await assert.rejects(
      backend.commit({ put: [put('n1', 'x'), put('n2', 'y'), put('n3', 'z')] }),
      isCode('limit_exceeded', { what: 'batch', limit: 2 }),
    );
    // '"12345"' is 7 bytes; '"123456"' is 8.
    await backend.commit({ put: [put('n1', '12345')] });
    await assert.rejects(
      backend.commit({ put: [put('n1', '123456')] }),
      isCode('limit_exceeded', { what: 'document', limit: 7 }),
    );
    await backend.commit({ append: [{ stream, events: ['abc'] }] });
    await assert.rejects(
      backend.commit({ append: [{ stream, events: ['abcd'] }] }),
      isCode('limit_exceeded', { what: 'append', limit: 5 }),
    );
    assert.deepEqual((await backend.get(key('n1')))?.value, '12345');
  },
);
