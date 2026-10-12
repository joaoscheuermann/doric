import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type Disposable,
  defineStorageType,
  type Storage,
  StorageV1,
} from 'bundle/contracts';
import { z } from 'zod';

import { boot, core, type ProbeKind, probe } from './support/host.js';

// D-ST: the storage/v1 facade over the protocol (stage 2+3 design §5.2).

const noteType = defineStorageType({
  type: 'notes.note/v1',
  schema: z.object({
    title: z.string(),
    folder: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
  }),
  indexes: [{ name: 'by-folder', fields: ['folder', 'title'] }],
});

/** A bundle that hands its own storage/v1 stub to the test. */
const user = (
  id: string,
  provides: readonly (readonly [string, ProbeKind])[] = [],
) => {
  let storage: Storage | undefined;

  return {
    bundle: probe(id, {
      requires: ['storage/v1@^1.0.0'],
      provides,
      activate: ({ services }) => {
        storage = services.use(StorageV1);
      },
    }),
    get storage(): Storage {
      assert.ok(storage, `${id} is not active`);

      return storage;
    },
  };
};

const notesProvides = [
  ['notes.note/v1', 'storage-type'],
  ['notes.other/v1', 'storage-type'],
] as const;

void test('a type is defined only by the bundle its namespace names, and only when listed in provides', async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle]);

  try {
    assert.throws(
      () =>
        notes.storage.defineType(
          defineStorageType({
            type: 'other.note/v1',
            schema: z.object({}),
            indexes: [],
          }),
        ),
      { code: 'not_owner' },
    );
    assert.throws(
      () =>
        notes.storage.defineType(
          defineStorageType({
            type: 'notes.undeclared/v1',
            schema: z.object({}),
            indexes: [],
          }),
        ),
      { code: 'undeclared_provide' },
    );
  } finally {
    await host.close();
  }
});

void test('index names are unique and every indexed field exists in the schema', async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle]);
  const schema = z.object({
    title: z.string(),
    meta: z.object({ rank: z.number() }).optional(),
  });

  try {
    assert.throws(
      () =>
        notes.storage.defineType(
          defineStorageType({
            type: 'notes.other/v1',
            schema,
            indexes: [
              { name: 'twice', fields: ['title'] },
              { name: 'twice', fields: ['meta.rank'] },
            ],
          }),
        ),
      { code: 'invalid_input' },
    );
    assert.throws(
      () =>
        notes.storage.defineType(
          defineStorageType({
            type: 'notes.other/v1',
            schema,
            indexes: [{ name: 'missing', fields: ['meta.score'] }],
          }),
        ),
      { code: 'invalid_input' },
    );

    // A nested field through an optional object resolves.
    notes.storage.defineType(
      defineStorageType({
        type: 'notes.other/v1',
        schema,
        indexes: [{ name: 'by-rank', fields: ['meta.rank', 'title'] }],
      }),
    );
  } finally {
    await host.close();
  }
});

void test('defining a type again is idempotent for its owner, and a conflict with another schema', async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle]);

  try {
    notes.storage.defineType(noteType);
    notes.storage.defineType(noteType);

    assert.throws(
      () =>
        notes.storage.defineType(
          defineStorageType({
            type: 'notes.note/v1',
            schema: z.object({ body: z.string() }),
            indexes: [],
          }),
        ),
      { code: 'registration_conflict' },
    );
  } finally {
    await host.close();
  }
});

void test('a written value is the output of the type schema, and a refused value commits nothing', async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle]);

  try {
    notes.storage.defineType(noteType);

    await notes.storage.commit({
      put: [{ type: 'notes.note/v1', id: 'a', value: { title: 'A', x: 1 } }],
    });

    assert.deepEqual(
      await notes.storage.get({ type: 'notes.note/v1', id: 'a' }),
      {
        type: 'notes.note/v1',
        id: 'a',
        revision: 1,
        value: { title: 'A', folder: null, tags: [] },
      },
    );

    await assert.rejects(
      notes.storage.commit({
        put: [
          { type: 'notes.note/v1', id: 'b', value: { title: 'B' } },
          { type: 'notes.note/v1', id: 'c', value: { title: 3 } },
        ],
      }),
      { code: 'invalid_input' },
    );
    assert.equal(
      await notes.storage.get({ type: 'notes.note/v1', id: 'b' }),
      undefined,
    );
  } finally {
    await host.close();
  }
});

void test('an operation on a type nobody defined is unknown_type', async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle]);

  try {
    await assert.rejects(
      notes.storage.get({ type: 'notes.note/v1', id: 'a' }),
      { code: 'unknown_type' },
    );
    await assert.rejects(
      notes.storage.commit({
        put: [{ type: 'notes.note/v1', id: 'a', value: { title: 'A' } }],
      }),
      { code: 'unknown_type' },
    );
  } finally {
    await host.close();
  }
});

void test('only the owner reads or writes its documents; the platform reads them', async () => {
  const notes = user('notes', notesProvides);
  const other = user('other');
  const host = await boot([await core(), notes.bundle, other.bundle]);

  try {
    notes.storage.defineType(noteType);
    await notes.storage.commit({
      put: [{ type: 'notes.note/v1', id: 'a', value: { title: 'A' } }],
    });

    await assert.rejects(
      other.storage.get({ type: 'notes.note/v1', id: 'a' }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      other.storage.query({
        type: 'notes.note/v1',
        index: 'by-folder',
        equals: [],
        limit: 10,
      }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      other.storage.commit({
        delete: [{ type: 'notes.note/v1', id: 'a' }],
      }),
      { code: 'not_owner' },
    );

    const read = await host.platform.services
      .use(StorageV1)
      .get({ type: 'notes.note/v1', id: 'a' });

    assert.equal(read?.revision, 1);
  } finally {
    await host.close();
  }
});

void test('a stream is written and read only by the bundle its first segment names', async () => {
  const notes = user('notes', notesProvides);
  const other = user('other');
  const host = await boot([await core(), notes.bundle, other.bundle]);

  try {
    await notes.storage.commit({
      append: [{ stream: 'notes.log/a', events: [{ n: 1 }, { n: 2 }] }],
    });

    const page = await notes.storage.read({
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
      other.storage.commit({
        append: [{ stream: 'notes.log/a', events: [{ n: 3 }] }],
      }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      other.storage.commit({ dropStreams: ['notes.log/a'] }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      other.storage.read({ stream: 'notes.log/a', afterSequence: 0, limit: 1 }),
      { code: 'not_owner' },
    );
    await assert.rejects(
      notes.storage.commit({
        append: [{ stream: 'notes', events: [{ n: 1 }] }],
      }),
      { code: 'invalid_stream' },
    );

    const after = await notes.storage.read({
      stream: 'notes.log/a',
      afterSequence: 0,
      limit: 10,
    });

    assert.equal(after.lastSequence, 2);
  } finally {
    await host.close();
  }
});

void test("the backend's limits refuse a batch before anything is written", async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle], {
    memory: { storage: { limits: { maxBatch: 2, maxDocumentBytes: 64 } } },
  });

  try {
    notes.storage.defineType(noteType);

    await assert.rejects(
      notes.storage.commit({
        put: ['a', 'b', 'c'].map((id) => ({
          type: 'notes.note/v1',
          id,
          value: { title: id },
        })),
      }),
      { code: 'limit_exceeded' },
    );
    await assert.rejects(
      notes.storage.commit({
        put: [
          {
            type: 'notes.note/v1',
            id: 'big',
            value: { title: 'x'.repeat(64) },
          },
        ],
      }),
      { code: 'limit_exceeded' },
    );
    await assert.rejects(notes.storage.commit({}), { code: 'invalid_input' });

    assert.equal(
      await notes.storage.get({ type: 'notes.note/v1', id: 'a' }),
      undefined,
    );

    // At the limit, the batch is accepted.
    await notes.storage.commit({
      put: ['a', 'b'].map((id) => ({
        type: 'notes.note/v1',
        id,
        value: { title: id },
      })),
    });
    assert.equal(
      (await notes.storage.get({ type: 'notes.note/v1', id: 'b' }))?.revision,
      1,
    );
  } finally {
    await host.close();
  }
});

void test('activation reaches no backend, and a type is declared to it on first use', async () => {
  const calls: string[] = [];
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle], {
    backendCalls: calls,
  });

  try {
    notes.storage.defineType(noteType);

    // Core defined its own types and the probe defined one: still no I/O.
    assert.deepEqual(calls, []);

    await notes.storage.commit({
      put: [
        { type: 'notes.note/v1', id: 'b', value: { title: 'B', folder: 'x' } },
        { type: 'notes.note/v1', id: 'a', value: { title: 'A', folder: 'x' } },
        { type: 'notes.note/v1', id: 'c', value: { title: 'C' } },
      ],
    });

    // The query runs on the declared index.
    const page = await notes.storage.query({
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
    await host.close();
  }
});

void test('disposing a type keeps its data: the platform still reads it, and a new definition sees it', async () => {
  const notes = user('notes', notesProvides);
  const host = await boot([await core(), notes.bundle]);

  try {
    const defined: Disposable = notes.storage.defineType(noteType);

    await notes.storage.commit({
      put: [{ type: 'notes.note/v1', id: 'a', value: { title: 'A' } }],
    });
    defined.dispose();

    await assert.rejects(
      notes.storage.get({ type: 'notes.note/v1', id: 'a' }),
      { code: 'unknown_type' },
    );
    assert.equal(
      (
        await host.platform.services
          .use(StorageV1)
          .get({ type: 'notes.note/v1', id: 'a' })
      )?.revision,
      1,
    );

    notes.storage.defineType(noteType);
    assert.equal(
      (await notes.storage.get({ type: 'notes.note/v1', id: 'a' }))?.revision,
      1,
    );
  } finally {
    await host.close();
  }
});

void test("health is the backend's measurement", async () => {
  const notes = user('notes');
  const host = await boot([await core(), notes.bundle], {
    memory: {
      storage: {
        health: () => ({
          status: 'ok',
          writable: true,
          disk: { blocks: 100, availableBlocks: 9 },
        }),
      },
    },
  });

  try {
    assert.deepEqual(await notes.storage.health(), {
      status: 'ok',
      writable: true,
      disk: { blocks: 100, availableBlocks: 9 },
    });
  } finally {
    await host.close();
  }
});
