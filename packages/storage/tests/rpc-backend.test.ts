// `storage.backend/v1` over the router (spec `docs/designs/grpc-processes.md`,
// section 17, "Storage until phase 4"; T3.9): the memory backend served by
// `serveStorageBackend` through `createTestRouter`, called through
// `storageBackendClient` and through the raw Connect client to observe the
// wire shape of each stream.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import {
  fromConnectError,
  isContractError,
  type StorageBackend,
} from 'bundle/contracts';
import type { CommitRequestSchema } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';

import { createMemoryStore } from '../src/memory/index.js';
import { memoryBackend, serveStorage } from './support/router-harness.js';

const MiB = 1_048_576;
const thread = 'test.thread/v1';
const events = (id: string) => `test.thread.events/${id}`;
const utf8 = new TextEncoder();

const isCode = (code: string, details?: unknown) => (error: unknown) => {
  assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
  assert.equal(error.code, code, error.message);

  if (details !== undefined) {
    assert.deepEqual(error.details, details);
  }

  return true;
};

/** Asserts a raw call failed with the Doric code `code`. */
const rejectsRaw = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConnectError, `expected a ConnectError: ${error}`);
    assert.equal(fromConnectError(error).code, code, error.message);

    return true;
  });
};

const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];

  for await (const item of stream) {
    items.push(item);
  }

  return items;
};

async function* streamOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

/** Wraps `backend` so the test sees how often `commit` reached it. */
const countingCommits = (backend: StorageBackend) => {
  const counts = { commit: 0 };
  const wrapped: StorageBackend = {
    declareType: (...args) => backend.declareType(...args),
    get: (...args) => backend.get(...args),
    query: (...args) => backend.query(...args),
    read: (...args) => backend.read(...args),
    commit: (...args) => {
      counts.commit += 1;

      return backend.commit(...args);
    },
    feed: (...args) => backend.feed(...args),
    putBlob: (...args) => backend.putBlob(...args),
    getBlob: (...args) => backend.getBlob(...args),
    deleteBlob: (...args) => backend.deleteBlob(...args),
    capabilities: (...args) => backend.capabilities(...args),
    health: (...args) => backend.health(...args),
    identity: (...args) => backend.identity(...args),
    connect: (...args) => backend.connect(...args),
  };

  return { backend: wrapped, counts };
};

/**
 * The memory backend served through the router: `direct` is the memory
 * backend itself (what the server calls), `backend` the client adapter,
 * `raw` the router's Connect client, `counts` the commits that reached it.
 */
const open = async (t: TestContext) => {
  const memory = memoryBackend(createMemoryStore());
  const counted = countingCommits(memory.backend);

  t.after(() => memory.dispose());

  const served = await serveStorage(counted.backend);

  t.after(() => served.stop());

  return {
    direct: memory.backend,
    backend: served.backend,
    raw: served.raw,
    counts: counted.counts,
  };
};

const declareThreads = (backend: StorageBackend) =>
  backend.declareType({
    type: thread,
    indexes: [{ name: 'byProject', fields: ['projectId', 'createdAt'] }],
  });

/** A string of exactly `bytes` UTF-8 bytes with 1-, 2-, 3- and 4-byte characters. */
const multiByteText = (bytes: number): string => {
  const unit = 'aé€😀'; // 1 + 2 + 3 + 4 = 10 bytes

  return unit.repeat(Math.floor(bytes / 10)) + 'a'.repeat(bytes % 10);
};

// Test list 2 -----------------------------------------------------------------

void test('a 5 MiB document crosses in chunks and reads back whole through get and query', async (t) => {
  const { backend, raw } = await open(t);
  const body = multiByteText(5 * MiB + 17);

  assert.equal(utf8.encode(body).length, 5 * MiB + 17);

  const value = { projectId: 'p', createdAt: '1', body };

  await declareThreads(backend);
  await backend.commit({ put: [{ type: thread, id: 'big', value }] });

  assert.deepEqual(await backend.get({ type: thread, id: 'big' }), {
    type: thread,
    id: 'big',
    revision: 1,
    value,
  });

  const page = await backend.query({
    type: thread,
    index: 'byProject',
    equals: ['p'],
    limit: 10,
  });

  assert.deepEqual(page.items, [{ type: thread, id: 'big', revision: 1, value }]);

  const items = await collect(raw.get({ type: thread, id: 'big' }));
  const [first, ...rest] = items;

  assert.equal(first?.item.case, 'document');
  assert.deepEqual(
    first?.item.case === 'document'
      ? {
          type: first.item.value.type,
          id: first.item.value.id,
          revision: first.item.value.revision,
        }
      : undefined,
    { type: thread, id: 'big', revision: 1 },
  );
  assert.ok(rest.length >= 6, `expected at least 6 chunks, got ${rest.length}`);

  for (const item of rest) {
    assert.equal(item.item.case, 'chunk');
    assert.ok(
      item.item.case === 'chunk' &&
        item.item.value.length > 0 &&
        item.item.value.length <= MiB,
    );
  }
});

// Test list 3 -----------------------------------------------------------------

void test('a 2 MiB event crosses in chunks and reads back whole through read', async (t) => {
  const { backend, raw } = await open(t);
  const event = { text: multiByteText(2 * MiB + 5) };

  await backend.commit({ append: [{ stream: events('t1'), events: [event] }] });

  const page = await backend.read({
    stream: events('t1'),
    afterSequence: 0,
    limit: 10,
  });

  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]?.sequence, 1);
  assert.deepEqual(page.entries[0]?.value, event);
  assert.equal(page.lastSequence, 1);

  const items = await collect(
    raw.read({ streamRead: { stream: events('t1'), afterSequence: 0, limit: 10 } }),
  );
  const cases = items.map(({ item }) => item.case);

  assert.deepEqual(cases.slice(0, 2), ['page', 'entry']);
  assert.ok(
    cases.slice(2).length >= 2 && cases.slice(2).every((c) => c === 'chunk'),
    `expected the entry followed by at least 2 chunks, got ${cases.join(',')}`,
  );
});

// Test list 4 -----------------------------------------------------------------

void test('a missing document is no item on the wire and undefined through the client', async (t) => {
  const { backend, raw } = await open(t);

  assert.deepEqual(await collect(raw.get({ type: thread, id: 'missing' })), []);
  assert.equal(await backend.get({ type: thread, id: 'missing' }), undefined);
});

// Test list 5 -----------------------------------------------------------------

void test('query answers its page head first, with the cursor when more follow', async (t) => {
  const { backend, raw } = await open(t);

  await declareThreads(backend);
  await backend.commit({
    put: ['1', '2', '3'].map((n) => ({
      type: thread,
      id: `t${n}`,
      value: { projectId: 'p', createdAt: n },
    })),
  });

  const items = await collect(
    raw.query({
      storageQuery: {
        type: thread,
        index: 'byProject',
        equals: [{ kind: { case: 'stringValue', value: 'p' } }],
        limit: 2,
      },
    }),
  );
  const [head, ...rest] = items;

  assert.equal(head?.item.case, 'page');
  assert.ok(
    head?.item.case === 'page' && typeof head.item.value.cursor === 'string',
    'the head of a page that is not the last carries its cursor',
  );
  assert.deepEqual(
    rest.filter(({ item }) => item.case === 'page'),
    [],
    'one page item only',
  );
  assert.deepEqual(
    rest
      .filter(({ item }) => item.case === 'document')
      .map(({ item }) => (item.case === 'document' ? item.value.id : '')),
    ['t1', 't2'],
  );

  const page = await backend.query({
    type: thread,
    index: 'byProject',
    equals: ['p'],
    limit: 2,
  });

  assert.deepEqual(
    page.items.map(({ id }) => id),
    ['t1', 't2'],
  );
  assert.equal(typeof page.cursor, 'string');
});

void test('a query matching nothing is exactly one page item', async (t) => {
  const { backend, raw } = await open(t);

  await declareThreads(backend);

  const items = await collect(
    raw.query({
      storageQuery: {
        type: thread,
        index: 'byProject',
        equals: [{ kind: { case: 'stringValue', value: 'nobody' } }],
        limit: 10,
      },
    }),
  );

  assert.deepEqual(
    items.map(({ item }) => item.case),
    ['page'],
  );
  assert.deepEqual(
    await backend.query({
      type: thread,
      index: 'byProject',
      equals: ['nobody'],
      limit: 10,
    }),
    { items: [] },
  );
});

void test('read answers its page head first, also for an empty stream', async (t) => {
  const { backend, raw } = await open(t);

  const empty = await collect(
    raw.read({ streamRead: { stream: events('none'), afterSequence: 0, limit: 10 } }),
  );

  assert.equal(empty.length, 1);
  assert.equal(empty[0]?.item.case, 'page');
  assert.ok(empty[0]?.item.case === 'page');
  assert.equal(empty[0].item.value.lastSequence, 0);
  assert.deepEqual(empty[0].item.value.truncations, []);

  await backend.commit({
    append: [{ stream: events('t1'), events: ['a', 'b'] }],
  });

  const items = await collect(
    raw.read({ streamRead: { stream: events('t1'), afterSequence: 0, limit: 10 } }),
  );

  assert.equal(items[0]?.item.case, 'page');
  assert.ok(items[0]?.item.case === 'page');
  assert.equal(items[0].item.value.lastSequence, 2);
  assert.deepEqual(
    items.slice(1).map(({ item }) => item.case),
    ['entry', 'chunk', 'entry', 'chunk'],
  );
  assert.deepEqual(
    await backend.read({ stream: events('none'), afterSequence: 0, limit: 10 }),
    { entries: [], lastSequence: 0, truncations: [] },
  );
});

// Test list 6 -----------------------------------------------------------------

void test('getBlob answers its head first, then the bytes in chunks', async (t) => {
  const { backend, raw } = await open(t);
  const bytes = new Uint8Array(3 * MiB + 3);

  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }

  const base64 = Buffer.from(bytes).toString('base64');
  const { hash } = await backend.putBlob(base64);

  const items = await collect(raw.getBlob({ hash }));
  const [head, ...rest] = items;

  assert.ok(head?.item.case === 'head', 'the head comes first');
  assert.equal(head.item.value.found, true);
  assert.ok(rest.every(({ item }) => item.case === 'chunk'));

  const joined = Buffer.concat(
    rest.map(({ item }) => (item.case === 'chunk' ? item.value : new Uint8Array())),
  );

  assert.ok(joined.equals(Buffer.from(bytes)), 'the chunks join to the bytes');
  assert.equal(await backend.getBlob(hash), base64);
});

void test('an unknown blob is one head with found false; the empty blob one head and no chunk', async (t) => {
  const { backend, raw } = await open(t);
  const unknown = `sha256:${'0'.repeat(64)}`;

  const missing = await collect(raw.getBlob({ hash: unknown }));

  assert.equal(missing.length, 1);
  assert.ok(missing[0]?.item.case === 'head');
  assert.equal(missing[0].item.value.found, false);
  assert.equal(await backend.getBlob(unknown), undefined);

  const { hash } = await backend.putBlob('');
  const empty = await collect(raw.getBlob({ hash }));

  assert.equal(empty.length, 1);
  assert.ok(empty[0]?.item.case === 'head');
  assert.equal(empty[0].item.value.found, true);
  assert.equal(await backend.getBlob(hash), '');
});

// Test list 7 -----------------------------------------------------------------

type CommitItem = MessageInitShape<typeof CommitRequestSchema>;

const malformedCommits: readonly (readonly [string, readonly CommitItem[]])[] = [
  ['a chunk first', [{ item: { case: 'chunk', value: utf8.encode('{}') } }]],
  [
    'a put with no chunk',
    [{ item: { case: 'put', value: { type: thread, id: 't1' } } }],
  ],
  [
    'an append with no event',
    [{ item: { case: 'append', value: { stream: events('t1') } } }],
  ],
  [
    'two truncate items',
    [
      {
        item: {
          case: 'truncate',
          value: { stream: events('t1'), afterSequence: 0 },
        },
      },
      {
        item: {
          case: 'truncate',
          value: { stream: events('t2'), afterSequence: 0 },
        },
      },
    ],
  ],
  [
    'a put whose chunk is not JSON',
    [
      { item: { case: 'put', value: { type: thread, id: 't1' } } },
      { item: { case: 'chunk', value: utf8.encode('{') } },
    ],
  ],
];

void test('a malformed commit stream fails with invalid_input and applies nothing', async (t) => {
  const { direct, raw, counts } = await open(t);

  await direct.commit({ put: [{ type: thread, id: 'seed', value: 1 }] });

  const before = await direct.feed({ after: 0, limit: 100 });
  const commitsBefore = counts.commit;

  for (const [what, items] of malformedCommits) {
    await t.test(what, async () => {
      await rejectsRaw(raw.commit(streamOf(items)), 'invalid_input');
      assert.equal(counts.commit, commitsBefore, 'the backend was not called');
      assert.deepEqual(await direct.feed({ after: 0, limit: 100 }), before);
    });
  }
});

// Test list 8 -----------------------------------------------------------------

void test('the client refuses a value JSON cannot hold before any call', async (t) => {
  const { direct, backend, counts } = await open(t);

  await assert.rejects(
    backend.commit({ put: [{ type: thread, id: 't1', value: 1n }] }),
    isCode('invalid_input'),
  );
  assert.equal(counts.commit, 0, 'no commit reached the backend');
  assert.deepEqual(await direct.feed({ after: 0, limit: 100 }), {
    commits: [],
  });
  assert.equal(await direct.get({ type: thread, id: 't1' }), undefined);
});

// Test list 9 -----------------------------------------------------------------

void test('a backend error crosses with its code and details', async (t) => {
  const { backend } = await open(t);

  await backend.commit({ put: [{ type: thread, id: 't1', value: 'one' }] });

  const update = {
    expect: [{ type: thread, id: 't1', revision: 1 }],
    put: [{ type: thread, id: 't1', value: 'two' }],
  };

  await backend.commit(update);
  await assert.rejects(
    backend.commit(update),
    isCode('revision_conflict', {
      type: thread,
      id: 't1',
      expected: 1,
      actual: 2,
    }),
  );
});

// Test list 10 ----------------------------------------------------------------

void test('an aborted signal cancels the call before the backend is reached', async (t) => {
  let calls = 0;
  const reached = (): never => {
    calls += 1;
    throw new Error('the backend must not be reached');
  };
  const fake: StorageBackend = {
    declareType: async () => reached(),
    get: async () => reached(),
    query: async () => reached(),
    read: async () => reached(),
    commit: async () => reached(),
    feed: async () => reached(),
    putBlob: async () => reached(),
    getBlob: async () => reached(),
    deleteBlob: async () => reached(),
    capabilities: async () => reached(),
    health: async () => reached(),
    identity: async () => reached(),
    connect: async () => reached(),
  };
  const served = await serveStorage(fake);

  t.after(() => served.stop());

  const signal = AbortSignal.abort();

  await assert.rejects(
    served.backend.get({ type: thread, id: 't1' }, { signal }),
    isCode('cancelled'),
  );
  await assert.rejects(served.backend.health({ signal }), isCode('cancelled'));
  await assert.rejects(
    served.backend.commit(
      { put: [{ type: thread, id: 't1', value: 1 }] },
      { signal },
    ),
    isCode('cancelled'),
  );
  assert.equal(calls, 0);
});
