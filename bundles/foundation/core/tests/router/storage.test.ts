// `storage/v1` served by `core` over the router (S39a): the port of
// `../storage.test.ts` onto `createCoreServices` and `createTestRouter`.
// Refusals of `defineType` arrive through `StorageClient.settled()`.

import assert from 'node:assert/strict';
import test from 'node:test';

import { defineStorageType } from 'bundle/contracts';
import { z } from 'zod';

import { type RoutedCore, serveCore } from '../support/router.js';

const noteType = defineStorageType({
  type: 'notes.note/v1',
  schema: z.object({ title: z.string(), folder: z.string() }),
  indexes: [{ name: 'by-folder', fields: ['folder', 'title'] }],
});

const notesProvides = ['notes.note/v1@1.0.0', 'notes.other/v1@1.0.0'];

const served = (
  options: Parameters<typeof serveCore>[0] = {},
): Promise<RoutedCore> =>
  serveCore({
    bundles: { notes: notesProvides, other: [] },
    ...options,
  });

const note = (id: string, title = id, folder = 'inbox') => ({
  type: 'notes.note/v1',
  id,
  value: { title, folder },
});

void test('a type is defined only by the bundle its namespace names, and only when listed in provides', async () => {
  const core = await served();

  try {
    const other = core.storage('other');
    const notes = core.storage('notes');

    other.defineType(noteType);
    await assert.rejects(other.settled(), { code: 'not_owner' });

    notes.defineType(
      defineStorageType({
        type: 'notes.undeclared/v1',
        schema: z.object({}),
        indexes: [],
      }),
    );
    await assert.rejects(notes.settled(), { code: 'undeclared_provide' });

    // Neither refusal registered anything.
    await assert.rejects(notes.get({ type: 'notes.note/v1', id: 'a' }), {
      code: 'unknown_type',
    });
    await assert.rejects(
      notes.get({ type: 'notes.undeclared/v1', id: 'a' }),
      { code: 'unknown_type' },
    );
  } finally {
    await core.close();
  }
});

void test('two indexes with one name are invalid_input', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');

    notes.defineType(
      defineStorageType({
        type: 'notes.other/v1',
        schema: z.object({ title: z.string() }),
        indexes: [
          { name: 'twice', fields: ['title'] },
          { name: 'twice', fields: ['title'] },
        ],
      }),
    );
    await assert.rejects(notes.settled(), { code: 'invalid_input' });
  } finally {
    await core.close();
  }
});

void test('defining a type again is idempotent for its owner, and other indexes are a conflict', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');

    notes.defineType(noteType);
    notes.defineType(noteType);
    await notes.settled();

    notes.defineType(
      defineStorageType({
        type: 'notes.note/v1',
        schema: z.object({ title: z.string(), folder: z.string() }),
        indexes: [{ name: 'by-title', fields: ['title'] }],
      }),
    );
    await assert.rejects(notes.settled(), { code: 'registration_conflict' });
  } finally {
    await core.close();
  }
});

void test('a value its schema refuses is invalid_input and commits nothing; an accepted one reads back', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');

    notes.defineType(noteType);
    await notes.settled();

    await assert.rejects(
      notes.commit({
        put: [note('b'), { type: 'notes.note/v1', id: 'c', value: { title: 3 } }],
      }),
      { code: 'invalid_input' },
    );
    assert.equal(
      await core.storage('doric').get({ type: 'notes.note/v1', id: 'b' }),
      undefined,
    );

    await notes.commit({ put: [note('a', 'A')] });

    const read = await notes.get({ type: 'notes.note/v1', id: 'a' });

    assert.equal(read?.revision, 1);
    assert.deepEqual(read?.value, { title: 'A', folder: 'inbox' });
  } finally {
    await core.close();
  }
});

void test('a get, query or commit on a type nobody defined is unknown_type', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');

    await assert.rejects(notes.get({ type: 'notes.note/v1', id: 'a' }), {
      code: 'unknown_type',
    });
    await assert.rejects(
      notes.query({
        type: 'notes.note/v1',
        index: 'by-folder',
        equals: [],
        limit: 10,
      }),
      { code: 'unknown_type' },
    );
    await assert.rejects(notes.commit({ put: [note('a')] }), {
      code: 'unknown_type',
    });
  } finally {
    await core.close();
  }
});

void test('only the owner reads or writes its documents; the platform reads them, even with no definition', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');
    const other = core.storage('other');
    const platform = core.storage('doric', 0);

    const defined = notes.defineType(noteType);

    await notes.commit({ put: [note('a')] });

    await assert.rejects(other.get({ type: 'notes.note/v1', id: 'a' }), {
      code: 'not_owner',
    });
    await assert.rejects(
      other.query({
        type: 'notes.note/v1',
        index: 'by-folder',
        equals: [],
        limit: 10,
      }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      other.commit({ delete: [{ type: 'notes.note/v1', id: 'a' }] }),
      { code: 'not_owner' },
    );

    assert.equal(
      (await platform.get({ type: 'notes.note/v1', id: 'a' }))?.revision,
      1,
    );

    defined.dispose();
    await notes.settled();

    assert.equal(
      (await platform.get({ type: 'notes.note/v1', id: 'a' }))?.revision,
      1,
    );
  } finally {
    await core.close();
  }
});

void test('a stream is written and read only by the bundle its first segment names', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');
    const other = core.storage('other');

    await notes.commit({
      append: [{ stream: 'notes.log/a', events: [{ n: 1 }, { n: 2 }] }],
    });

    const page = await notes.read({
      stream: 'notes.log/a',
      afterSequence: 0,
      limit: 10,
    });

    assert.deepEqual(
      page.entries.map(({ sequence, value }) => [sequence, value]),
      [
        [1, { n: 1 }],
        [2, { n: 2 }],
      ],
    );

    await assert.rejects(
      other.commit({ append: [{ stream: 'notes.log/a', events: [{ n: 3 }] }] }),
      { code: 'not_owner' },
    );
    await assert.rejects(other.commit({ dropStreams: ['notes.log/a'] }), {
      code: 'not_owner',
    });
    await assert.rejects(
      other.commit({ truncate: { stream: 'notes.log/a', afterSequence: 1 } }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      other.read({ stream: 'notes.log/a', afterSequence: 0, limit: 1 }),
      { code: 'not_owner' },
    );

    const after = await notes.read({
      stream: 'notes.log/a',
      afterSequence: 0,
      limit: 10,
    });

    assert.equal(after.lastSequence, 2);
  } finally {
    await core.close();
  }
});

void test("the backend's limits refuse a batch before anything is written, and an empty commit is invalid_input", async () => {
  const core = await served({
    storageOptions: { limits: { maxBatch: 2, maxDocumentBytes: 64 } },
  });

  try {
    const notes = core.storage('notes');

    notes.defineType(noteType);
    await notes.settled();

    await assert.rejects(
      notes.commit({ put: [note('a'), note('b'), note('c')] }),
      { code: 'limit_exceeded' },
    );
    await assert.rejects(
      notes.commit({ put: [note('big', 'x'.repeat(64))] }),
      { code: 'limit_exceeded' },
    );
    await assert.rejects(notes.commit({}), { code: 'invalid_input' });

    assert.equal(
      await notes.get({ type: 'notes.note/v1', id: 'a' }),
      undefined,
    );

    // At the limit, the batch is accepted.
    await notes.commit({ put: [note('a'), note('b')] });
    assert.equal(
      (await notes.get({ type: 'notes.note/v1', id: 'b' }))?.revision,
      1,
    );
  } finally {
    await core.close();
  }
});

void test('activation and defineType reach no backend; the first commit declares the type once', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');

    notes.defineType(noteType);
    await notes.settled();

    assert.deepEqual([...core.backendCalls], []);
    assert.equal(core.store.types.has('notes.note/v1'), false);

    await notes.commit({
      put: [note('b', 'B', 'x'), note('a', 'A', 'x'), note('c', 'C', 'y')],
    });
    await notes.commit({ put: [note('d', 'D', 'y')] });

    assert.equal(
      core.backendCalls.filter((name) => name === 'declareType').length,
      1,
    );
    assert.ok(
      core.backendCalls.indexOf('declareType') <
        core.backendCalls.indexOf('commit'),
      core.backendCalls.join(', '),
    );
    assert.ok(core.store.types.has('notes.note/v1'));

    // The query runs on the declared index.
    const page = await notes.query({
      type: 'notes.note/v1',
      index: 'by-folder',
      equals: ['x'],
      limit: 10,
    });

    assert.deepEqual(
      page.items.map(({ id }) => id),
      ['a', 'b'],
    );
  } finally {
    await core.close();
  }
});

void test('disposing a type keeps its data: the platform still reads it, and a new definition sees it', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');
    const defined = notes.defineType(noteType);

    await notes.commit({ put: [note('a')] });
    defined.dispose();

    await assert.rejects(notes.get({ type: 'notes.note/v1', id: 'a' }), {
      code: 'unknown_type',
    });
    assert.equal(
      (await core.storage('doric', 0).get({ type: 'notes.note/v1', id: 'a' }))
        ?.revision,
      1,
    );

    notes.defineType(noteType);
    assert.equal(
      (await notes.get({ type: 'notes.note/v1', id: 'a' }))?.revision,
      1,
    );
  } finally {
    await core.close();
  }
});

void test("health is the backend's measurement", async () => {
  const core = await served({
    storageOptions: {
      health: () => ({
        status: 'ok',
        writable: true,
        disk: { blocks: 100, availableBlocks: 9 },
      }),
    },
  });

  try {
    assert.deepEqual(await core.storage('notes').health(), {
      status: 'ok',
      writable: true,
      disk: { blocks: 100, availableBlocks: 9 },
    });
  } finally {
    await core.close();
  }
});

void test("views follow the router's stamp: a type of generation 2 is unknown to generation 1", async () => {
  const core = await served();

  try {
    const second = core.storage('notes', 2);
    const first = core.storage('notes', 1);

    second.defineType(noteType);
    await second.settled();
    await second.commit({ put: [note('a')] });

    await assert.rejects(first.get({ type: 'notes.note/v1', id: 'a' }), {
      code: 'unknown_type',
    });

    // Generation 1 defining it with other indexes is not a conflict.
    first.defineType(
      defineStorageType({
        type: 'notes.note/v1',
        schema: z.object({ title: z.string(), folder: z.string() }),
        indexes: [{ name: 'by-title', fields: ['title'] }],
      }),
    );
    await first.settled();

    assert.equal(
      (await second.get({ type: 'notes.note/v1', id: 'a' }))?.revision,
      1,
    );
  } finally {
    await core.close();
  }
});

void test('an InstanceGone disposes the storage types that instance defined; its documents stay', async () => {
  const core = await served();

  try {
    const notes = core.storage('notes');

    notes.defineType(noteType);
    await notes.commit({ put: [note('a')] });

    core.instanceGone({ bundleId: 'notes', generation: 1 });

    await assert.rejects(notes.get({ type: 'notes.note/v1', id: 'a' }), {
      code: 'unknown_type',
    });
    assert.equal(
      (await core.storage('doric', 0).get({ type: 'notes.note/v1', id: 'a' }))
        ?.revision,
      1,
    );
  } finally {
    await core.close();
  }
});
