import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { createTestServices } from 'bundle';
import {
  isContractError,
  SecretsBackendV1,
  type StorageBackend,
  StorageBackendV1,
  type StoredSecret,
} from 'bundle/contracts';

import {
  createMemoryStore,
  type MemorySecretsOptions,
  type MemoryStorageOptions,
  type MemoryStore,
  memorySecretsBackend,
  memoryStorageBackend,
} from '../src/memory/index.js';

const isCode = (code: string, details?: unknown) => (error: unknown) => {
  assert.ok(isContractError(error), String(error));
  assert.equal(error.code, code);

  if (details !== undefined) {
    assert.deepEqual(error.details, details);
  }

  return true;
};

/** A backend instance over `store`, reached through the real dispatcher. */
const open = (
  t: TestContext,
  store: MemoryStore = createMemoryStore(),
  options?: MemoryStorageOptions,
): StorageBackend => {
  const harness = createTestServices({
    bundle: { id: 'storage-test' },
    provide: [memoryStorageBackend(store, options)],
  });

  t.after(() => harness.dispose());

  return harness.services.use(StorageBackendV1);
};

const thread = 'test.thread/v1';
const events = (id: string) => `test.thread.events/${id}`;

const declareThreads = (backend: StorageBackend) =>
  backend.declareType({
    type: thread,
    indexes: [
      { name: 'byProject', fields: ['projectId', 'createdAt'] },
      { name: 'byName', fields: ['name'], unique: true },
    ],
  });

const put = (id: string, value: unknown) => ({ type: thread, id, value });

const ids = (page: { items: readonly { id: string }[] }) =>
  page.items.map(({ id }) => id);

void test('a put document reads back with revision 1, then one more per put', async (t) => {
  const backend = open(t);

  await backend.commit({ put: [put('t1', { name: 'one' })] });
  assert.deepEqual(await backend.get({ type: thread, id: 't1' }), {
    type: thread,
    id: 't1',
    revision: 1,
    value: { name: 'one' },
  });

  await backend.commit({ put: [put('t1', { name: 'two' })] });
  assert.equal((await backend.get({ type: thread, id: 't1' }))?.revision, 2);

  await backend.commit({ delete: [{ type: thread, id: 't1' }] });
  assert.equal(await backend.get({ type: thread, id: 't1' }), undefined);
});

void test('a stored value is a copy: mutating the input or a read changes nothing', async (t) => {
  const backend = open(t);
  const value = { list: [1] };

  await backend.commit({ put: [put('t1', value)] });
  value.list.push(2);

  const read = await backend.get({ type: thread, id: 't1' });

  assert.ok(read !== undefined);
  (read.value as { list: number[] }).list.push(3);
  assert.deepEqual((await backend.get({ type: thread, id: 't1' }))?.value, {
    list: [1],
  });
});

void test('expect revision 0 passes only while the document is absent', async (t) => {
  const backend = open(t);
  const create = {
    expect: [{ type: thread, id: 't1', revision: 0 }],
    put: [put('t1', { name: 'one' })],
  };

  await backend.commit(create);
  await assert.rejects(
    backend.commit(create),
    isCode('revision_conflict', {
      type: thread,
      id: 't1',
      expected: 0,
      actual: 1,
    }),
  );
});

void test('a failed commit leaves no document, entry, sequence or feed trace', async (t) => {
  const backend = open(t);

  await declareThreads(backend);
  await backend.commit({
    put: [put('t1', { projectId: 'p', createdAt: '1', name: 'taken' })],
    append: [{ stream: events('t1'), events: ['first'] }],
  });

  const failures = [
    // A stale expect after everything else.
    {
      put: [put('t2', { projectId: 'p', createdAt: '2', name: 'new' })],
      append: [{ stream: events('t1'), events: ['lost'] }],
      expect: [{ type: thread, id: 't1', revision: 5 }],
    },
    // A unique violation raised after another put applied.
    {
      put: [
        put('t2', { projectId: 'p', createdAt: '2', name: 'new' }),
        put('t3', { projectId: 'p', createdAt: '3', name: 'taken' }),
      ],
      append: [{ stream: events('t1'), events: ['lost'] }],
    },
    // A sequence conflict after a truncate of the same stream.
    {
      truncate: { stream: events('t1'), afterSequence: 0 },
      append: [{ stream: events('t1'), expectedSequence: 0, events: ['lost'] }],
    },
    // An indexed object.
    {
      delete: [{ type: thread, id: 't1' }],
      put: [put('t2', { projectId: { nested: true }, name: 'x' })],
    },
    // Dropping a stream, then reading after its end.
    {
      dropStreams: [events('t1')],
      truncate: { stream: events('t1'), afterSequence: 1 },
    },
  ];
  const codes = [
    'revision_conflict',
    'unique_conflict',
    'sequence_conflict',
    'invalid_index_value',
    'invalid_input',
  ];

  for (const [index, batch] of failures.entries()) {
    await assert.rejects(backend.commit(batch), isCode(codes[index] as string));
  }

  assert.equal(await backend.get({ type: thread, id: 't2' }), undefined);
  assert.equal((await backend.get({ type: thread, id: 't1' }))?.revision, 1);
  assert.deepEqual(
    ids(
      await backend.query({
        type: thread,
        index: 'byProject',
        equals: ['p'],
        limit: 10,
      }),
    ),
    ['t1'],
  );
  assert.deepEqual(
    ids(
      await backend.query({
        type: thread,
        index: 'byName',
        equals: ['taken'],
        limit: 10,
      }),
    ),
    ['t1'],
  );

  const stream = await backend.read({
    stream: events('t1'),
    afterSequence: 0,
    limit: 10,
  });

  assert.deepEqual(
    stream.entries.map(({ sequence, value }) => [sequence, value]),
    [[1, 'first']],
  );
  assert.equal(stream.lastSequence, 1);
  assert.deepEqual(stream.truncations, []);
  assert.equal((await backend.feed({ after: 0, limit: 10 })).commits.length, 1);
});

void test('an empty batch is invalid_input and over-limit batches are limit_exceeded', async (t) => {
  const backend = open(t, createMemoryStore(), {
    limits: { maxBatch: 2, maxDocumentBytes: 16 },
  });

  await assert.rejects(backend.commit({}), isCode('invalid_input'));
  await assert.rejects(
    backend.commit({ put: [put('a', 1), put('b', 2), put('c', 3)] }),
    isCode('limit_exceeded', { what: 'batch', limit: 2 }),
  );
  await assert.rejects(
    backend.commit({ put: [put('a', 'x'.repeat(20))] }),
    isCode('limit_exceeded', { what: 'document', limit: 16 }),
  );
  assert.deepEqual((await backend.feed({ after: 0, limit: 10 })).commits, []);

  const capabilities = await backend.capabilities();

  assert.equal(capabilities.maxBatch, 2);
  assert.equal(capabilities.maxDocumentBytes, 16);
  assert.ok(capabilities.maxAppendBytes > 0);
});

void test('parallel commits on one revision: exactly one wins', async (t) => {
  const backend = open(t);

  await backend.commit({ put: [put('t1', { n: 0 })] });

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, n) =>
      backend.commit({
        expect: [{ type: thread, id: 't1', revision: 1 }],
        put: [put('t1', { n })],
      }),
    ),
  );

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(
    results.every(
      (r) =>
        r.status === 'fulfilled' ||
        (isContractError(r.reason) && r.reason.code === 'revision_conflict'),
    ),
  );
  assert.equal((await backend.get({ type: thread, id: 't1' }))?.revision, 2);
});

void test('parallel appends get contiguous unique sequences; an expected sequence admits one', async (t) => {
  const backend = open(t);

  await Promise.all(
    Array.from({ length: 50 }, (_, n) =>
      backend.commit({ append: [{ stream: events('t1'), events: [n] }] }),
    ),
  );

  const page = await backend.read({
    stream: events('t1'),
    afterSequence: 0,
    limit: 100,
  });

  assert.deepEqual(
    page.entries.map(({ sequence }) => sequence),
    Array.from({ length: 50 }, (_, n) => n + 1),
  );

  const contended = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      backend.commit({
        append: [{ stream: events('t1'), expectedSequence: 50, events: ['x'] }],
      }),
    ),
  );

  assert.equal(contended.filter((r) => r.status === 'fulfilled').length, 1);
  assert.ok(
    contended.every(
      (r) =>
        r.status === 'fulfilled' ||
        (isContractError(r.reason) && r.reason.code === 'sequence_conflict'),
    ),
  );
});

void test('queries select by equality and range, ordered by key and then by ID', async (t) => {
  const backend = open(t);

  await declareThreads(backend);
  await backend.commit({
    put: [
      put('b', { projectId: 'p', createdAt: '2', name: 'b' }),
      put('a', { projectId: 'p', createdAt: '2', name: 'a' }),
      put('c', { projectId: 'p', createdAt: '1', name: 'c' }),
      put('d', { projectId: 'p', createdAt: '3', name: 'd' }),
      put('e', { projectId: 'q', createdAt: '1', name: 'e' }),
      // An absent field is indexed as null.
      put('f', { createdAt: '1', name: 'f' }),
    ],
  });

  const select = async (query: Record<string, unknown>) =>
    ids(
      await backend.query({
        type: thread,
        index: 'byProject',
        equals: [],
        limit: 100,
        ...query,
      }),
    );

  assert.deepEqual(await select({ equals: ['p'] }), ['c', 'a', 'b', 'd']);
  assert.deepEqual(await select({ equals: ['p'], order: 'desc' }), [
    'd',
    'b',
    'a',
    'c',
  ]);
  assert.deepEqual(await select({ equals: ['p'], range: { gt: '1' } }), [
    'a',
    'b',
    'd',
  ]);
  assert.deepEqual(
    await select({ equals: ['p'], range: { gte: '2', lt: '3' } }),
    ['a', 'b'],
  );
  assert.deepEqual(await select({ equals: ['p'], range: { lte: '2' } }), [
    'c',
    'a',
    'b',
  ]);
  assert.deepEqual(await select({ equals: [null] }), ['f']);
  assert.deepEqual(await select({}), ['f', 'c', 'a', 'b', 'd', 'e']);
});

void test('pages of any size walk every item once, across inserts outside the page', async (t) => {
  const backend = open(t);

  await declareThreads(backend);

  const total = 9;

  await backend.commit({
    put: Array.from({ length: total }, (_, n) =>
      put(`t${n}`, {
        projectId: 'p',
        createdAt: String(n * 10),
        name: `n${n}`,
      }),
    ),
  });

  for (const order of ['asc', 'desc'] as const) {
    for (let limit = 1; limit <= total + 1; limit += 1) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const page = await backend.query({
          type: thread,
          index: 'byProject',
          equals: ['p'],
          order,
          limit,
          ...(cursor === undefined ? {} : { cursor }),
        });

        seen.push(...ids(page));
        cursor = page.cursor;
        pages += 1;

        if (pages === 1 && order === 'asc' && limit < total) {
          // Behind the cursor: never shows up; ahead of it: shows up once.
          await backend.commit({
            put: [
              put('behind', { projectId: 'p', createdAt: '', name: 'behind' }),
              put('ahead', { projectId: 'p', createdAt: '9', name: 'ahead' }),
            ],
          });
        }
      } while (cursor !== undefined);

      const expected = Array.from({ length: total }, (_, n) => `t${n}`);
      const inserted = order === 'asc' && limit < total;

      assert.deepEqual(
        seen,
        order === 'asc'
          ? [...expected, ...(inserted ? ['ahead'] : [])]
          : expected.reverse(),
        `${order} limit ${limit}`,
      );

      if (inserted) {
        await backend.commit({
          delete: [
            { type: thread, id: 'behind' },
            { type: thread, id: 'ahead' },
          ],
        });
      }
    }
  }
});

void test('a put moves a document between keys, and a delete removes its entries', async (t) => {
  const backend = open(t);

  await declareThreads(backend);
  await backend.commit({
    put: [put('t1', { projectId: 'p', createdAt: '1', name: 'one' })],
  });
  await backend.commit({
    put: [put('t1', { projectId: 'q', createdAt: '1', name: 'one' })],
  });

  const byProject = (projectId: string) =>
    backend.query({
      type: thread,
      index: 'byProject',
      equals: [projectId],
      limit: 10,
    });

  assert.deepEqual(ids(await byProject('p')), []);
  assert.deepEqual(ids(await byProject('q')), ['t1']);

  await backend.commit({ delete: [{ type: thread, id: 't1' }] });
  assert.deepEqual(ids(await byProject('q')), []);

  // The freed unique key can be taken again.
  await backend.commit({
    put: [put('t2', { projectId: 'q', createdAt: '1', name: 'one' })],
  });
});

void test('a query on an undeclared index, too many fields or a bad cursor is invalid_input', async (t) => {
  const backend = open(t);

  await declareThreads(backend);

  for (const query of [
    { index: 'missing', equals: [] },
    { index: 'byName', equals: ['a', 'b'] },
    { index: 'byName', equals: ['a'], range: { gt: 'a' } },
    { index: 'byName', equals: [], cursor: 'not-a-cursor' },
  ]) {
    await assert.rejects(
      backend.query({ type: thread, limit: 10, ...query }),
      isCode('invalid_input'),
    );
  }
});

void test('declaring an index builds entries for stored documents and never deletes data', async (t) => {
  const store = createMemoryStore();
  const backend = open(t, store);

  // An undeclared type is stored and readable, with no index.
  await backend.commit({
    put: [put('t1', { name: 'same' }), put('t2', { name: 'same' })],
  });
  await backend.declareType({
    type: thread,
    indexes: [{ name: 'byName', fields: ['name'] }],
  });
  assert.deepEqual(
    ids(
      await backend.query({
        type: thread,
        index: 'byName',
        equals: ['same'],
        limit: 10,
      }),
    ),
    ['t1', 't2'],
  );

  // A unique index the stored data breaks is refused and changes nothing.
  await assert.rejects(
    backend.declareType({
      type: thread,
      indexes: [{ name: 'byName', fields: ['name'], unique: true }],
    }),
    isCode('unique_conflict', { type: thread, index: 'byName' }),
  );
  await backend.commit({ put: [put('t3', { name: 'same' })] });

  // Dropping every index keeps the documents.
  await backend.declareType({ type: thread, indexes: [] });
  assert.equal((await backend.get({ type: thread, id: 't3' }))?.revision, 1);
  await assert.rejects(
    backend.query({ type: thread, index: 'byName', equals: [], limit: 10 }),
    isCode('invalid_input'),
  );
});

void test('streams number from 1, keep their counter across truncation and report the marks', async (t) => {
  const backend = open(t);
  const stream = events('t1');

  await backend.commit({
    append: [{ stream, expectedSequence: 0, events: ['a', 'b', 'c', 'd'] }],
  });
  await backend.commit({
    truncate: { stream, afterSequence: 2 },
    append: [{ stream, expectedSequence: 4, events: ['e'] }],
  });

  const all = await backend.read({ stream, afterSequence: 0, limit: 10 });

  assert.deepEqual(
    all.entries.map(({ sequence, value }) => [sequence, value]),
    [
      [1, 'a'],
      [2, 'b'],
      [5, 'e'],
    ],
  );
  assert.equal(all.lastSequence, 5);
  for (const { createdAt } of all.entries) {
    assert.equal(new Date(createdAt).toISOString(), createdAt);
  }

  // Marks are reported to readers whose cursor the truncation affected.
  const markAt = async (afterSequence: number) =>
    (await backend.read({ stream, afterSequence, limit: 10 })).truncations;
  const mark = { afterSequence: 2, atSequence: 5 };

  assert.deepEqual(await markAt(0), []);
  assert.deepEqual(await markAt(2), []);
  assert.deepEqual(await markAt(3), [mark]);
  assert.deepEqual(await markAt(5), [mark]);

  // Reading by cursor and limit.
  const page = await backend.read({ stream, afterSequence: 1, limit: 1 });

  assert.deepEqual(
    page.entries.map(({ sequence }) => sequence),
    [2],
  );

  await assert.rejects(
    backend.read({ stream, afterSequence: 6, limit: 10 }),
    isCode('invalid_input'),
  );
  await assert.rejects(
    backend.commit({ truncate: { stream, afterSequence: 6 } }),
    isCode('invalid_input'),
  );
});

void test('an absent stream reads empty at 0, and a dropped stream starts over', async (t) => {
  const backend = open(t);
  const stream = events('t1');

  assert.deepEqual(await backend.read({ stream, afterSequence: 0, limit: 5 }), {
    entries: [],
    lastSequence: 0,
    truncations: [],
  });

  await backend.commit({ append: [{ stream, events: ['a', 'b'] }] });
  await backend.commit({ truncate: { stream, afterSequence: 1 } });
  await backend.commit({ dropStreams: [stream] });
  assert.deepEqual(await backend.read({ stream, afterSequence: 0, limit: 5 }), {
    entries: [],
    lastSequence: 0,
    truncations: [],
  });

  await backend.commit({
    append: [{ stream, expectedSequence: 0, events: ['c'] }],
  });
  assert.deepEqual(
    (await backend.read({ stream, afterSequence: 0, limit: 5 })).entries.map(
      ({ sequence, value }) => [sequence, value],
    ),
    [[1, 'c']],
  );
});

void test('the feed lists each commit once, in order, and survives a new instance', async (t) => {
  const store = createMemoryStore();
  const first = open(t, store);
  const stream = events('t1');

  const positions = [
    await first.commit({
      put: [put('t1', 1)],
      append: [{ stream, events: [1, 2] }],
    }),
    await first.commit({
      delete: [{ type: thread, id: 't1' }],
      truncate: { stream, afterSequence: 1 },
    }),
  ].map(({ position }) => position);

  await assert.rejects(
    first.commit({ expect: [{ type: thread, id: 'x', revision: 3 }] }),
  );

  const seen = await first.feed({ after: 0, limit: 10 });

  assert.deepEqual(seen.commits, [
    {
      position: positions[0],
      documents: [{ type: thread, id: 't1' }],
      streams: [stream],
      truncated: [],
      dropped: [],
    },
    {
      position: positions[1],
      documents: [{ type: thread, id: 't1' }],
      streams: [],
      truncated: [stream],
      dropped: [],
    },
  ]);
  assert.ok((positions[1] as number) > (positions[0] as number));

  // The first instance is abandoned; another one over the same store goes on.
  const second = open(t, store);
  const third = await second.commit({ dropStreams: [stream] });

  assert.ok(third.position > (positions[1] as number));
  assert.deepEqual(
    (await second.feed({ after: positions[1] as number, limit: 10 })).commits,
    [
      {
        position: third.position,
        documents: [],
        streams: [],
        truncated: [],
        dropped: [stream],
      },
    ],
  );
  assert.deepEqual(
    (await second.feed({ after: 0, limit: 1 })).commits.map(
      ({ position }) => position,
    ),
    [positions[0]],
  );
});

void test('blobs are content-addressed, idempotent and binary-safe', async (t) => {
  const backend = open(t);
  const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00]).toString('base64');
  const { hash } = await backend.putBlob(bytes);

  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(await backend.putBlob(bytes), { hash });
  assert.equal(await backend.getBlob(hash), bytes);
  assert.equal(await backend.getBlob(`sha256:${'0'.repeat(64)}`), undefined);
  assert.equal(await backend.getBlob('not-a-hash'), undefined);
  await assert.rejects(backend.putBlob('not base64!'), isCode('invalid_input'));

  // The empty blob has the well-known SHA-256 of no bytes.
  assert.deepEqual(await backend.putBlob(''), {
    hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
});

void test('the identity is created once per store and is stable across instances', async (t) => {
  const store = createMemoryStore();
  const identity = await open(t, store).identity();

  assert.equal(identity.storageGeneration, 1);
  assert.deepEqual(await open(t, store).identity(), identity);
  assert.notEqual(
    (await open(t, createMemoryStore()).identity()).hostId,
    identity.hostId,
  );
});

void test('health reports ok by default, or what the test injects', async (t) => {
  assert.deepEqual(await open(t).health(), { status: 'ok', writable: true });
  assert.deepEqual(
    await open(t, createMemoryStore(), {
      health: () => ({
        status: 'unavailable',
        writable: false,
        reason: 'storage_unmeasurable',
      }),
    }).health(),
    { status: 'unavailable', writable: false, reason: 'storage_unmeasurable' },
  );
});

// secrets.backend/v1 ----------------------------------------------------------

const openSecrets = (t: TestContext, options?: MemorySecretsOptions) => {
  const harness = createTestServices({
    bundle: { id: 'secrets-test' },
    provide: [memorySecretsBackend(options)],
  });

  t.after(() => harness.dispose());

  return harness.services.use(SecretsBackendV1);
};

const secret = (
  id: string,
  name: string,
  fields: Partial<StoredSecret> = {},
): StoredSecret => ({
  id,
  kind: 'API_TOKEN',
  name,
  secret: 'token',
  ...fields,
});

const fieldsOf = ({ createdAt: _c, updatedAt: _u, ...fields }: StoredSecret) =>
  fields;

void test('secrets are upserted by ID and listed by name', async (t) => {
  const backend = openSecrets(t);

  await backend.put(secret('1', 'openrouter'));
  await backend.put(secret('2', 'Anthropic'));
  await backend.put(
    secret('3', 'github', {
      kind: 'GIT',
      secret: undefined,
      username: 'u',
      email: 'e',
    }),
  );
  assert.deepEqual(
    (await backend.list()).map(({ name }) => name),
    ['Anthropic', 'github', 'openrouter'],
  );

  await backend.put(secret('1', 'openrouter', { secret: 'rotated' }));
  assert.deepEqual(fieldsOf((await backend.get('1')) as StoredSecret), {
    id: '1',
    kind: 'API_TOKEN',
    name: 'openrouter',
    secret: 'rotated',
  });
  assert.equal(await backend.get('missing'), undefined);

  assert.equal(await backend.delete('1'), 'deleted');
  assert.equal(await backend.delete('1'), 'missing');
  assert.equal(await backend.get('1'), undefined);
});

void test('an update keeps the stored kind and drops fields it no longer carries', async (t) => {
  const backend = openSecrets(t);

  await backend.put(
    secret('1', 'login', { kind: 'USERNAME_PASSWORD', username: 'octocat' }),
  );
  await backend.put(secret('1', 'login', { kind: 'API_TOKEN' }));

  const stored = (await backend.get('1')) as StoredSecret;

  assert.equal(stored.kind, 'USERNAME_PASSWORD');
  assert.equal(stored.username, undefined);
});

void test('a name is unique per kind', async (t) => {
  const backend = openSecrets(t);

  await backend.put(secret('1', 'shared'));
  await backend.put(
    secret('2', 'shared', {
      kind: 'GIT',
      secret: undefined,
      username: 'u',
      email: 'e',
    }),
  );
  await assert.rejects(
    backend.put(secret('3', 'shared')),
    isCode('credential_name_taken'),
  );
  // Renaming onto a name the kind already holds is refused too.
  await backend.put(secret('4', 'other'));
  await assert.rejects(
    backend.put(secret('1', 'other')),
    isCode('credential_name_taken'),
  );
  assert.equal((await backend.get('1'))?.name, 'shared');
});

void test('without a key, any secret write and any read of a held secret are refused', async (t) => {
  const backend = openSecrets(t, {
    keyConfigured: false,
    rows: [
      secret('git', 'identity', {
        kind: 'GIT',
        secret: undefined,
        username: 'u',
        email: 'e',
      }),
    ],
  });

  for (const value of ['token', '']) {
    await assert.rejects(
      backend.put(secret('1', 'openrouter', { secret: value })),
      isCode('credential_storage_unavailable'),
    );
  }

  await backend.put(
    secret('2', 'identity-2', {
      kind: 'GIT',
      secret: undefined,
      username: 'u',
      email: 'e',
    }),
  );
  assert.deepEqual(
    (await backend.list()).map(({ id }) => id),
    ['git', '2'],
  );

  const held = openSecrets(t, {
    keyConfigured: false,
    rows: [secret('1', 'openrouter'), secret('2', 'empty', { secret: '' })],
  });

  await assert.rejects(held.list(), isCode('credential_key_required'));
  await assert.rejects(held.get('1'), isCode('credential_key_required'));
  assert.equal((await held.get('2'))?.secret, '');
});
