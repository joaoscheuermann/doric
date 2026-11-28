// S77b1: the `storage/v2` client (spec `docs/designs/grpc-processes.md`, "The
// TypeScript client", "The storage contract", Q31's default, A39) over the
// `sqlite` engine bundle: values round-trip in chunks with their unknown
// fields, the client validates before any call, a value that does not decode
// is `invalid_output` in the client and, for a type with indexes,
// `invalid_input` in the engine, records stay under the bundle's prefix, and
// the stream and blob methods stay refused until S78 (T4.3's client cases).

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { create, equals, fromBinary, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import { closure, fromConnectError, isContractError } from 'bundle/contracts';
import {
  CommitRequestSchema,
  type StorageService,
} from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';

import {
  descriptorSetBytesLimit,
  registerOver,
  storageOver,
} from '../src/client/index.js';
import type { DocumentKey, Storage } from '../src/client/types.js';
import {
  concat,
  dump,
  everything,
  rangeAll,
  refusal,
} from '../src/conformance/kv/support.js';
import {
  file_doric_storage_conformance_v1_conformance,
  type Note,
  NoteSchema,
  PlainSchema,
  ThreadSchema,
} from '../src/contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import type { Kv } from '../src/kv.js';
import {
  openTestEngine,
  openTestStorage,
  type TestEngine,
  type TestStorage,
} from '../src/testing.js';
import { feedFile, oversizedFile } from './support/descriptors.js';
import { openRawEngine, type RawEngine } from './support/raw-engine.js';

const caseTimeoutMs = 120_000;
const note = 'conformance.note/v1';
const plain = 'conformance.plain/v1';
const feed = feedFile();
/** The conformance types, and the stream prefix `conformance.feed/`. */
const files = [file_doric_storage_conformance_v1_conformance, feed.file];
/** The most bytes of one document's value (`limit` `"document"`). */
const documentBytes = 16_777_216;

const noteKey = (id: string): DocumentKey => ({ type: note, id });

const latin1 = (key: Uint8Array): string => Buffer.from(key).toString('latin1');

/** Every key of the store, read through `kv`, in key order. */
const keysOf = async (kv: Kv): Promise<string[]> =>
  (await rangeAll(kv, { ...everything, limit: 1000 })).map((entry) =>
    latin1(entry.key),
  );

/** A `ContractError` of `code` with exactly `message`. */
const refusedWith =
  (code: string, message: string) =>
  (error: unknown): boolean => {
    assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
    assert.deepEqual(
      { code: error.code, message: error.message },
      { code, message },
    );

    return true;
  };

/** A `ConnectError` carrying the `ContractError` of `code`. */
const connectRefusal =
  (code: string) =>
  (error: unknown): boolean => {
    assert.ok(
      error instanceof ConnectError,
      `not a ConnectError: ${String(error)}`,
    );
    assert.equal(fromConnectError(error).code, code, error.message);

    return true;
  };

describe('the storage/v2 client over openTestStorage', {
  timeout: caseTimeoutMs,
}, () => {
  let opened: TestStorage | undefined;

  before(async () => {
    opened = await openTestStorage('conformance', files);
  });

  after(async () => {
    await opened?.close();
  });

  beforeEach(async () => {
    await testStorage().reset();
  });

  const testStorage = (): TestStorage => {
    assert.ok(opened, 'the test storage opened');

    return opened;
  };
  const storage = (): Storage => testStorage().storage;

  test('CL1: a put note reads back equal at revision 1; an absent one is undefined', async () => {
    const value = create(NoteSchema, {
      title: 'first',
      tag: 'a',
      body: Uint8Array.of(1, 2, 3),
    });

    await storage().commit({ put: [{ ...noteKey('n1'), value }] });
    const stored = await storage().get<Note>(noteKey('n1'));

    assert.ok(stored, 'n1 is stored');
    assert.deepEqual(
      { type: stored.type, id: stored.id, revision: stored.revision },
      { type: note, id: 'n1', revision: 1 },
    );
    assert.ok(
      equals(NoteSchema, stored.value, value),
      'the value reads back equal',
    );
    assert.equal(await storage().get(noteKey('absent')), undefined);
  });

  test('CL2: a value of exactly 16 MiB round-trips; one byte more is limit_exceeded', async () => {
    // `title` "big" encodes in 5 bytes (tag, length, 3); `body` in a tag, a
    // 4-byte length varint (16 MiB < 2^28) and the bytes.
    const bodyBytes = documentBytes - 5 - 1 - 4;
    const value = create(NoteSchema, {
      title: 'big',
      body: new Uint8Array(bodyBytes).fill(0x62),
    });
    const over = create(NoteSchema, {
      title: 'over',
      body: new Uint8Array(bodyBytes),
    });

    assert.equal(toBinary(NoteSchema, value).length, documentBytes);
    assert.equal(toBinary(NoteSchema, over).length, documentBytes + 1);

    await storage().commit({ put: [{ ...noteKey('big'), value }] });
    const stored = await storage().get<Note>(noteKey('big'));

    assert.ok(stored, 'big is stored');
    assert.ok(
      equals(NoteSchema, stored.value, value),
      'the 16 MiB value reads back equal',
    );
    await assert.rejects(
      storage().commit({ put: [{ ...noteKey('over'), value: over }] }),
      refusal('limit_exceeded', { limit: 'document' }),
    );
    assert.equal(await storage().get(noteKey('over')), undefined);
  });

  test('CL3: a value with unknown fields reads back with the same bytes', async () => {
    // Field 99, varint 42: no field of `Note`.
    const written = concat(
      toBinary(NoteSchema, create(NoteSchema, { title: 'unknown', tag: 'u' })),
      Uint8Array.of(0x98, 0x06, 0x2a),
    );

    await storage().commit({
      put: [{ ...noteKey('u'), value: fromBinary(NoteSchema, written) }],
    });
    const stored = await storage().get<Note>(noteKey('u'));

    assert.ok(stored, 'u is stored');
    assert.deepEqual(toBinary(NoteSchema, stored.value), written);
  });

  test('CL6: a type with no message, and a Plain put as a note, are invalid_input and write nothing', async () => {
    const kept = await keysOf(testStorage().kv);

    await assert.rejects(
      storage().commit({
        put: [
          {
            type: 'conformance.missing/v1',
            id: 'm',
            value: create(NoteSchema, { title: 'm' }),
          },
        ],
      }),
      refusal('invalid_input'),
    );
    await assert.rejects(
      storage().commit({
        put: [{ ...noteKey('p'), value: create(PlainSchema, { text: 'p' }) }],
      }),
      refusal('invalid_input'),
    );
    assert.deepEqual(await keysOf(testStorage().kv), kept);
  });

  test('CL7: a title of 65 characters is invalid_input naming the document, and writes nothing', async () => {
    const kept = await keysOf(testStorage().kv);
    const value = create(NoteSchema, { title: 't'.repeat(65) });

    await assert.rejects(
      storage().commit({ put: [{ ...noteKey('long'), value }] }),
      refusal('invalid_input', { type: note, id: 'long' }),
    );
    assert.deepEqual(await keysOf(testStorage().kv), kept);
  });

  test('CL10: a call whose signal already aborted is cancelled', async () => {
    const controller = new AbortController();

    controller.abort();
    await assert.rejects(
      storage().get(noteKey('n1'), { signal: controller.signal }),
      refusal('cancelled'),
    );
    await assert.rejects(
      storage().commit(
        {
          put: [
            { ...noteKey('n1'), value: create(NoteSchema, { title: 'n1' }) },
          ],
        },
        { signal: controller.signal },
      ),
      refusal('cancelled'),
    );
    assert.equal(await storage().get(noteKey('n1')), undefined);
  });

  test('CL11: every key outside doric/ is under conformance/', async () => {
    await storage().commit({
      put: [
        {
          ...noteKey('n1'),
          value: create(NoteSchema, { title: 'n1', tag: 'a' }),
        },
        { type: plain, id: 'p1', value: create(PlainSchema, { text: 'p1' }) },
      ],
    });
    await storage().commit({
      put: [
        {
          type: 'conformance.thread/v1',
          id: 't1',
          value: create(ThreadSchema, {
            projectId: 'p',
            createdAt: '2026-11-28T12:00:00.000Z',
            owner: { id: 'o' },
          }),
        },
      ],
      delete: [{ type: plain, id: 'p1' }],
    });

    const outside = (await keysOf(testStorage().kv)).filter(
      (key) => !key.startsWith('doric/'),
    );

    assert.ok(outside.length > 0, 'the commits wrote keys');
    assert.deepEqual(
      outside.filter((key) => !key.startsWith('conformance/')),
      [],
    );
  });

  test('CL13: stream items are refused by the engine with invalid_input', async () => {
    const message = 'Stream items are not supported.';
    const stream = 'conformance.feed/one';

    await assert.rejects(
      storage().commit({
        append: [{ stream, events: [create(feed.event, { text: 'e' })] }],
      }),
      refusedWith('invalid_input', message),
    );
    await assert.rejects(
      storage().commit({ truncate: { stream, afterSequence: 0 } }),
      refusedWith('invalid_input', message),
    );
    await assert.rejects(
      storage().commit({ dropStreams: [stream] }),
      refusedWith('invalid_input', message),
    );
  });

  test('CL13: read, health and putBlob are unknown_contract until S78', async () => {
    const unserved = (method: string): string =>
      `This bundle does not serve /doric.storage.v2.StorageService/${method}.`;

    await assert.rejects(
      storage().read({
        stream: 'conformance.feed/one',
        afterSequence: 0,
        limit: 1,
      }),
      refusedWith('unknown_contract', unserved('Read')),
    );
    await assert.rejects(
      storage().health(),
      refusedWith('unknown_contract', unserved('Health')),
    );
    await assert.rejects(
      storage().putBlob(Uint8Array.of(1, 2, 3)),
      refusedWith('unknown_contract', unserved('PutBlob')),
    );
  });
});

/** A `Commit` of one put of `type`/`id` whose value is the chunk `value`. */
const rawPut = (
  client: Client<typeof StorageService>,
  type: string,
  id: string,
  value: Uint8Array,
) =>
  client.commit(
    (async function* () {
      yield create(CommitRequestSchema, {
        item: { case: 'put', value: { type, id } },
      });
      yield create(CommitRequestSchema, { item: { case: 'chunk', value } });
    })(),
  );

describe('values the client never writes', { timeout: caseTimeoutMs }, () => {
  let raw: RawEngine | undefined;

  before(async () => {
    raw = await openRawEngine();
    await registerOver(raw.storage('conformance'), files);
  });

  after(async () => {
    await raw?.close();
  });

  const engine = (): RawEngine => {
    assert.ok(raw, 'the engine opened');

    return raw;
  };

  // `Plain` has no index, so the engine stores the bytes as they came, and
  // it cannot be queried: only `get` reads it.
  test('CL4: a stored Plain value that does not decode is invalid_output', async () => {
    const client = engine().storage('conformance');

    await rawPut(client, plain, 'bad', Uint8Array.of(0x0f));
    const storage = await storageOver(client, files);

    await assert.rejects(
      storage.get({ type: plain, id: 'bad' }),
      refusal('invalid_output', { type: plain, id: 'bad' }),
    );
  });

  test('CL5: a Note value that does not decode is invalid_input in the engine, and nothing is stored', async () => {
    const client = engine().storage('conformance');
    const kept = await keysOf(engine().kv);

    await assert.rejects(
      rawPut(client, note, 'bad', Uint8Array.of(0x0f)),
      connectRefusal('invalid_input'),
    );
    assert.deepEqual(await keysOf(engine().kv), kept);
    assert.equal(
      await (await storageOver(client, files)).get(noteKey('bad')),
      undefined,
    );
  });
});

describe('registrations TestEngine.storage refuses', {
  timeout: caseTimeoutMs,
}, () => {
  let opened: TestEngine | undefined;

  before(async () => {
    opened = await openTestEngine();
  });

  after(async () => {
    await opened?.close();
  });

  beforeEach(async () => {
    await engine().reset();
  });

  const engine = (): TestEngine => {
    assert.ok(opened, 'the engine opened');

    return opened;
  };

  test("CL8: another bundle's types are not_owner, and nothing is written under it", async () => {
    await assert.rejects(
      engine().storage('other', files),
      refusal('not_owner'),
    );
    assert.deepEqual(await dump(engine()), []);
  });

  test('CL9: a descriptor set over 2 MiB is limit_exceeded before any call', async () => {
    const big = oversizedFile('conformance');
    const setBytes = toBinary(
      FileDescriptorSetSchema,
      create(FileDescriptorSetSchema, {
        file: closure([big]).map((file) => file.proto),
      }),
    ).length;

    assert.ok(setBytes > descriptorSetBytesLimit, `${setBytes} bytes`);
    await assert.rejects(
      engine().storage('conformance', [big]),
      refusal('limit_exceeded', { limit: 'descriptorSet' }),
    );
    assert.deepEqual(await dump(engine()), [], 'no schema key is written');
  });

  test('CL12: the bundle id doric is not_owner', async () => {
    await assert.rejects(
      engine().storage('doric', files),
      refusal('not_owner'),
    );
    assert.deepEqual(await dump(engine()), []);
  });
});
