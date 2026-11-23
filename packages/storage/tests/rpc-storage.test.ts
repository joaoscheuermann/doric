// `storage/v1` over the router (spec `docs/designs/grpc-processes.md`,
// section 17, "Storage until phase 4"; T3.9): a recording facade over the
// memory backend served by `serveStorage` through `createTestRouter`, called
// through `storageClient` and through the raw Connect client to observe the
// wire shape of each stream and the registrations' lifetime.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { DescService, MessageInitShape } from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  ajvValidators,
  type BundleInstance,
  type HostInstances,
  type HostRegistrations,
  type TrackOptions,
} from 'bundle';
import {
  type Caller,
  type CallScope,
  defineStorageType,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import {
  type CommitRequestSchema,
  StorageService,
} from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';
import { createTestRouter } from 'bundle/testing';
import { z } from 'zod';

import {
  type ServeStorageOptions,
  type StorageClientOptions,
  serveStorage,
  storageClient,
} from '../src/rpc/index.js';
import { memoryFacade } from './support/facade.js';

type Raw = Client<typeof StorageService>;

const MiB = 1_048_576;
const utf8 = new TextEncoder();
const note = 'notes.note/v1';
const big = 'notes.big/v1';
const events = (id: string) => `notes.events/${id}`;

const callerOf = (bundleId: string, generation = 1): Caller => ({
  bundleId,
  version: '1.0.0',
  generation,
});
const notes = callerOf('notes');
const other = callerOf('other');

const noteSchema = z.object({
  title: z.string(),
  kind: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const noteType = defineStorageType({
  type: note,
  schema: noteSchema,
  indexes: [
    { name: 'by_title', fields: ['title'], unique: true },
    { name: 'by_kind', fields: ['kind'] },
  ],
});

const bigType = defineStorageType({
  type: big,
  schema: z.object({ projectId: z.string(), body: z.string() }),
  indexes: [{ name: 'by_project', fields: ['projectId'] }],
});

/** The wire form of a type the raw client defines. */
const rawNoteRequest = {
  type: note,
  schema: {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: ['title'],
  },
  indexes: [{ name: 'by_title', fields: ['title'], unique: true }],
};

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

/** A string of exactly `bytes` UTF-8 bytes with 1-, 2-, 3- and 4-byte characters. */
const multiByteText = (bytes: number): string => {
  const unit = 'aé€😀'; // 1 + 2 + 3 + 4 = 10 bytes

  return unit.repeat(Math.floor(bytes / 10)) + 'a'.repeat(bytes % 10);
};

/**
 * A raw client that records the `DefineType` and `Undefine` requests it
 * sends and the `registrationId`s `DefineType` answered, in order.
 */
const recording = (raw: Raw) => {
  const defines: unknown[] = [];
  const answered: string[] = [];
  const undefines: string[] = [];
  const client: Raw = {
    ...raw,
    defineType: async (request, options) => {
      defines.push(request);

      const answer = await raw.defineType(request, options);

      answered.push(answer.registrationId);

      return answer;
    },
    undefine: async (request, options) => {
      undefines.push(request.registrationId ?? '');

      return await raw.undefine(request, options);
    },
  };

  return { client, defines, answered, undefines };
};

/**
 * A recording facade served by `serveStorage` (with `ajvValidators()` and
 * `options`) on a fresh `createTestRouter`.
 */
const open = async (
  t: TestContext,
  options: Omit<ServeStorageOptions, 'validators'> = {},
) => {
  const facade = memoryFacade();

  t.after(() => facade.close());

  const router = createTestRouter();

  await router.activate({
    services: [
      [
        StorageService,
        serveStorage(facade, { validators: ajvValidators(), ...options }),
      ],
    ],
    activate: () => {},
  });
  t.after(() => router.control.stop());

  const rawOf = (caller: Caller = notes, scope?: CallScope): Raw =>
    router.client(StorageService, {
      caller,
      ...(scope === undefined ? {} : { scope }),
    });
  const storageOf = (
    caller: Caller = notes,
    clientOptions?: StorageClientOptions,
  ) => storageClient(rawOf(caller), clientOptions);

  return { facade, rawOf, storageOf };
};

const methodsOf = (facade: ReturnType<typeof memoryFacade>) =>
  facade.calls.map(({ method }) => method);

// Test list 1 -----------------------------------------------------------------

void test('a zod type reaches the facade as a definition whose schema checks values as the original does', async (t) => {
  const { facade, storageOf } = await open(t);
  const storage = storageOf();

  storage.defineType(noteType);
  await storage.settled();

  const definition = facade.definitions.get(note);

  assert.ok(definition !== undefined, 'the facade received the definition');
  assert.equal(definition.type, note);
  assert.equal(definition.schema.safeParse({ title: 'A' }).success, true);

  const refused = definition.schema.safeParse({ title: 1 });

  assert.equal(refused.success, false);
  assert.ok(
    refused.error?.issues.some(
      ({ path }) => JSON.stringify(path) === JSON.stringify(['title']),
    ),
    `expected an issue at ['title'], got ${JSON.stringify(refused.error?.issues)}`,
  );
  assert.deepEqual(
    definition.indexes.map((index) => ({ ...index, fields: [...index.fields] })),
    [
      { name: 'by_title', fields: ['title'], unique: true },
      { name: 'by_kind', fields: ['kind'] },
    ],
  );
  assert.equal('unique' in (definition.indexes[1] ?? {}), false);

  await assert.rejects(
    storage.commit({ put: [{ type: note, id: 'n1', value: { title: 1 } }] }),
    isCode('invalid_input'),
  );
  assert.equal(await storage.get({ type: note, id: 'n1' }), undefined);

  await storage.commit({ put: [{ type: note, id: 'n1', value: { title: 'A' } }] });

  assert.deepEqual(await storage.get({ type: note, id: 'n1' }), {
    type: note,
    id: 'n1',
    revision: 1,
    value: { title: 'A' },
  });
});

// Test list 2 -----------------------------------------------------------------

void test('settled reports each refused definition once, with the facade error', async (t) => {
  const { storageOf } = await open(t);
  const storage = storageOf();

  storage.defineType(noteType);
  await storage.settled();

  storage.defineType(
    defineStorageType({
      type: 'other.note/v1',
      schema: noteSchema,
      indexes: [],
    }),
  );
  await assert.rejects(storage.settled(), isCode('not_owner'));
  await storage.settled();

  storage.defineType(
    defineStorageType({
      type: note,
      schema: noteSchema,
      indexes: [{ name: 'by_kind', fields: ['kind'] }],
    }),
  );
  await assert.rejects(storage.settled(), isCode('registration_conflict'));
});

// Test list 3 -----------------------------------------------------------------

void test('a call after defineType or dispose starts once the registration settled', async (t) => {
  const { facade, storageOf } = await open(t);
  const storage = storageOf();

  const type = storage.defineType(noteType);
  const committed = storage.commit({
    put: [{ type: note, id: 'n1', value: { title: 'A' } }],
  });

  assert.equal(typeof (await committed).position, 'number');

  const afterDefine = methodsOf(facade);

  assert.ok(
    afterDefine.indexOf('defineType') !== -1 &&
      afterDefine.indexOf('defineType') < afterDefine.indexOf('commit'),
    `expected defineType before commit, got ${afterDefine.join(',')}`,
  );

  type.dispose();

  await assert.rejects(
    storage.get({ type: note, id: 'n1' }),
    isCode('unknown_type'),
  );

  const afterDispose = methodsOf(facade);

  assert.ok(
    afterDispose.indexOf('dispose') !== -1 &&
      afterDispose.indexOf('dispose') < afterDispose.lastIndexOf('get'),
    `expected dispose before get, got ${afterDispose.join(',')}`,
  );
});

// Test list 4 -----------------------------------------------------------------

void test('dispose sends one Undefine however often it is called', async (t) => {
  const { facade, rawOf } = await open(t);
  const recorder = recording(rawOf());
  const storage = storageClient(recorder.client);

  const type = storage.defineType(noteType);

  await storage.settled();
  type.dispose();
  type.dispose();
  await storage.settled();

  assert.deepEqual(recorder.undefines, recorder.answered);
  assert.equal(recorder.undefines.length, 1);
  assert.equal(methodsOf(facade).filter((m) => m === 'dispose').length, 1);
});

void test('an unknown id, or one another bundle defined, is undefined as a no-op', async (t) => {
  const { facade, rawOf } = await open(t);

  const unknown = await rawOf().undefine({ registrationId: 'no-such-id' });

  assert.equal(unknown.$typeName, 'doric.storage.v1.UndefineResponse');

  const { registrationId } = await rawOf().defineType(rawNoteRequest);

  assert.ok(registrationId.length > 0, 'DefineType answers a registrationId');

  await rawOf(other).undefine({ registrationId });

  assert.equal(methodsOf(facade).filter((m) => m === 'dispose').length, 0);

  const storage = storageClient(rawOf());

  assert.equal(
    await storage.get({ type: note, id: 'n1' }),
    undefined,
    'the type is still defined',
  );
});

// Test list 5 -----------------------------------------------------------------

void test('InstanceGone disposes every registration of that instance and no other', async (t) => {
  const handlers: ((instance: BundleInstance) => void)[] = [];
  const instances: HostInstances = {
    onGone: (handler) => {
      handlers.push(handler);

      return () => {
        handlers.splice(handlers.indexOf(handler), 1);
      };
    },
  };
  const { facade, storageOf } = await open(t, { instances });
  const first = storageOf(callerOf('notes', 1));
  const second = storageOf(callerOf('notes', 2));
  const otherType = defineStorageType({
    type: 'notes.other/v1',
    schema: noteSchema,
    indexes: [],
  });

  first.defineType(noteType);
  first.defineType(otherType);
  second.defineType(noteType);
  await first.settled();
  await second.settled();

  assert.equal(handlers.length, 1, 'serveStorage listens to InstanceGone');

  for (const handler of handlers) {
    handler({ bundleId: 'notes', generation: 1, incarnation: 1 });
  }

  const disposed = facade.calls.filter(({ method }) => method === 'dispose');

  assert.deepEqual(
    disposed.map(({ input, caller }) => ({ input, generation: caller.generation })).sort(
      (a, b) => String(a.input).localeCompare(String(b.input)),
    ),
    [
      { input: note, generation: 1 },
      { input: 'notes.other/v1', generation: 1 },
    ],
  );
  assert.equal(await second.get({ type: note, id: 'n1' }), undefined);
  await assert.rejects(
    second.get({ type: 'notes.other/v1', id: 'n1' }),
    isCode('unknown_type'),
  );
});

// Test list 6 -----------------------------------------------------------------

void test('a replayed definition sends the same request, and dispose names the replay\'s id', async (t) => {
  const { facade, rawOf } = await open(t);
  const recorder = recording(rawOf());
  const kept: {
    readonly register: (client: Raw) => Promise<unknown>;
    readonly options?: TrackOptions<unknown>;
  }[] = [];
  const tracked: DescService[] = [];
  let untracked = 0;
  const registrations: HostRegistrations = {
    track: async <S extends DescService, R>(
      ref: S,
      register: (client: Client<S>) => Promise<R>,
      options?: TrackOptions<R>,
    ) => {
      tracked.push(ref);

      const current = await register(recorder.client as unknown as Client<S>);

      kept.push({
        register: register as unknown as (client: Raw) => Promise<unknown>,
        ...(options === undefined
          ? {}
          : { options: options as unknown as TrackOptions<unknown> }),
      });

      return {
        current,
        untrack: () => {
          untracked += 1;
        },
      };
    },
  };
  const storage = storageClient(recorder.client, { registrations });

  const type = storage.defineType(noteType);

  await storage.settled();

  assert.deepEqual(tracked, [StorageService]);
  assert.equal(kept.length, 1);

  const replay = kept[0];

  assert.ok(replay !== undefined);

  const answer = await replay.register(recorder.client);

  replay.options?.onReplayed?.(answer);

  assert.equal(recorder.defines.length, 2, 'the replay sent a second DefineType');
  assert.deepEqual(recorder.defines[1], recorder.defines[0]);
  assert.notEqual(recorder.answered[1], recorder.answered[0]);

  type.dispose();
  await storage.settled();

  assert.deepEqual(recorder.undefines, [recorder.answered[1]]);
  assert.equal(untracked, 1, 'dispose stops the replay');
  assert.equal(methodsOf(facade).filter((m) => m === 'dispose').length, 1);
});

// Test list 7 -----------------------------------------------------------------

void test('DefineType refuses a schema that does not compile and a malformed type without calling the facade', async (t) => {
  const { facade, rawOf } = await open(t);

  await rejectsRaw(
    rawOf().defineType({ type: note, schema: { type: 12 }, indexes: [] }),
    'invalid_input',
  );
  await rejectsRaw(
    rawOf().defineType({ ...rawNoteRequest, type: 'notes.Bad/v1' }),
    'invalid_input',
  );
  assert.deepEqual(facade.calls, []);
});

// Test list 8 -----------------------------------------------------------------

void test('the facade\'s call carries the client\'s caller and scope', async (t) => {
  const { facade, rawOf } = await open(t);
  const scope = { windowKey: 'w1' };
  const storage = storageClient(rawOf(callerOf('notes', 3), scope));

  await storage.health();

  assert.deepEqual(facade.calls, [
    {
      method: 'health',
      input: undefined,
      caller: { bundleId: 'notes', generation: 3 },
      scope,
    },
  ]);
});

// Test list 9 -----------------------------------------------------------------

void test('a 5 MiB document crosses in chunks and reads back whole through get and query', async (t) => {
  const { storageOf, rawOf } = await open(t);
  const storage = storageOf();
  const body = multiByteText(5 * MiB + 17);

  assert.equal(utf8.encode(body).length, 5 * MiB + 17);

  const value = { projectId: 'p', body };

  storage.defineType(bigType);
  await storage.commit({ put: [{ type: big, id: 'big', value }] });

  const document = { type: big, id: 'big', revision: 1, value };

  assert.deepEqual(await storage.get({ type: big, id: 'big' }), document);
  assert.deepEqual(
    (
      await storage.query({
        type: big,
        index: 'by_project',
        equals: ['p'],
        limit: 10,
      })
    ).items,
    [document],
  );

  const [first, ...rest] = await collect(rawOf().get({ type: big, id: 'big' }));

  assert.equal(first?.item.case, 'document');
  assert.ok(rest.length >= 6, `expected at least 6 chunks, got ${rest.length}`);

  for (const { item } of rest) {
    assert.equal(item.case, 'chunk');
    assert.ok(item.case === 'chunk' && item.value.length > 0 && item.value.length <= MiB);
  }
});

void test('a 2 MiB event crosses in chunks and reads back whole through read', async (t) => {
  const { storageOf, rawOf } = await open(t);
  const storage = storageOf();
  const event = { text: multiByteText(2 * MiB + 5) };

  await storage.commit({ append: [{ stream: events('t1'), events: [event] }] });

  const page = await storage.read({
    stream: events('t1'),
    afterSequence: 0,
    limit: 10,
  });

  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]?.sequence, 1);
  assert.deepEqual(page.entries[0]?.value, event);
  assert.equal(page.lastSequence, 1);

  const cases = (
    await collect(
      rawOf().read({
        streamRead: { stream: events('t1'), afterSequence: 0, limit: 10 },
      }),
    )
  ).map(({ item }) => item.case);

  assert.deepEqual(cases.slice(0, 2), ['page', 'entry']);
  assert.ok(
    cases.slice(2).length >= 2 && cases.slice(2).every((c) => c === 'chunk'),
    `expected the entry followed by at least 2 chunks, got ${cases.join(',')}`,
  );
});

// Test list 10 ----------------------------------------------------------------

void test('a missing document is no item, and an empty query one page item', async (t) => {
  const { storageOf, rawOf } = await open(t);
  const storage = storageOf();

  storage.defineType(noteType);
  await storage.settled();

  assert.deepEqual(await collect(rawOf().get({ type: note, id: 'missing' })), []);
  assert.equal(await storage.get({ type: note, id: 'missing' }), undefined);

  const items = await collect(
    rawOf().query({
      storageQuery: {
        type: note,
        index: 'by_title',
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
    await storage.query({ type: note, index: 'by_title', equals: ['nobody'], limit: 10 }),
    { items: [] },
  );
});

void test('an empty stream reads as one page item with lastSequence 0', async (t) => {
  const { storageOf, rawOf } = await open(t);

  const items = await collect(
    rawOf().read({
      streamRead: { stream: events('none'), afterSequence: 0, limit: 10 },
    }),
  );

  assert.equal(items.length, 1);
  assert.ok(items[0]?.item.case === 'page');
  assert.equal(items[0].item.value.lastSequence, 0);
  assert.deepEqual(
    await storageOf().read({ stream: events('none'), afterSequence: 0, limit: 10 }),
    { entries: [], lastSequence: 0, truncations: [] },
  );
});

void test('an unknown blob is one head with found false; the empty blob one head and no chunk', async (t) => {
  const { storageOf, rawOf } = await open(t);
  const storage = storageOf();
  const unknown = `sha256:${'0'.repeat(64)}`;

  const missing = await collect(rawOf().getBlob({ hash: unknown }));

  assert.equal(missing.length, 1);
  assert.ok(missing[0]?.item.case === 'head');
  assert.equal(missing[0].item.value.found, false);
  assert.equal(await storage.getBlob(unknown), undefined);

  const { hash } = await storage.putBlob('');
  const empty = await collect(rawOf().getBlob({ hash }));

  assert.equal(empty.length, 1);
  assert.ok(empty[0]?.item.case === 'head');
  assert.equal(empty[0].item.value.found, true);
  assert.equal(await storage.getBlob(hash), '');
});

// Test list 11 ----------------------------------------------------------------

type CommitItem = MessageInitShape<typeof CommitRequestSchema>;

const malformedCommits: readonly (readonly [string, readonly CommitItem[]])[] = [
  ['a chunk first', [{ item: { case: 'chunk', value: utf8.encode('{}') } }]],
  [
    'a put with no chunk',
    [{ item: { case: 'put', value: { type: note, id: 'n1' } } }],
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
      { item: { case: 'put', value: { type: note, id: 'n1' } } },
      { item: { case: 'chunk', value: utf8.encode('{') } },
    ],
  ],
];

void test('a malformed commit stream fails with invalid_input without calling the facade', async (t) => {
  const { facade, rawOf } = await open(t);

  for (const [what, items] of malformedCommits) {
    await t.test(what, async () => {
      await rejectsRaw(rawOf().commit(streamOf(items)), 'invalid_input');
      assert.deepEqual(methodsOf(facade).filter((m) => m === 'commit'), []);
    });
  }
});

// Test list 12 ----------------------------------------------------------------

void test('a facade error crosses with its code and details', async (t) => {
  const { storageOf } = await open(t);
  const storage = storageOf();
  const create = {
    expect: [{ type: note, id: 'n1', revision: 0 }],
    put: [{ type: note, id: 'n1', value: { title: 'A' } }],
  };

  storage.defineType(noteType);
  await storage.commit(create);
  await assert.rejects(
    storage.commit(create),
    isCode('revision_conflict', { type: note, id: 'n1', expected: 0, actual: 1 }),
  );
});

// Test list 13 ----------------------------------------------------------------

void test('an aborted signal cancels the call before the facade is reached', async (t) => {
  const { facade, storageOf } = await open(t);
  const storage = storageOf();
  const signal = AbortSignal.abort();

  await assert.rejects(
    storage.get({ type: note, id: 'n1' }, { signal }),
    isCode('cancelled'),
  );
  await assert.rejects(storage.health({ signal }), isCode('cancelled'));
  await assert.rejects(
    storage.commit(
      { put: [{ type: note, id: 'n1', value: { title: 'A' } }] },
      { signal },
    ),
    isCode('cancelled'),
  );
  assert.deepEqual(facade.calls, []);
});
