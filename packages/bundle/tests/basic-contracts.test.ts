import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CatalogSnapshot,
  type ContractErrorCode,
  commitBatchSchema,
  contractErrorCodes,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
  credentialKinds,
  eventSinkSpecSchema,
  feedPageSchema,
  isContractError,
  isSecretsView,
  SecretsV1,
  type SecretsView,
  SettingsV1,
  StorageBackendV1,
  StorageV1,
  secretsMethods,
  settingsEntrySchema,
  settingsMethods,
  storageBackendMethods,
  storageHealthSchema,
  storageIdentitySchema,
  storageMethods,
  storageQuerySchema,
  streamEntrySchema,
  streamPageSchema,
  streamReadSchema,
} from '../src/contracts/index.js';
import { catalogSnapshotSchema } from '../src/contracts/platform.js';
import { platformSchemaDocuments } from '../src/index.js';
import { createTestServices } from '../src/testing/index.js';
import { basicProvider } from './support/basic.js';

const codeOf = (expected: string) => (error: unknown) =>
  isContractError(error) && error.code === expected;

const accepts =
  (schema: { safeParse(value: unknown): { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

const uuid = '0b8f4d1e-3c2a-4f6b-9a7d-5e1c2b3a4d5f';

// storage/v1 and storage.backend/v1 -----------------------------------------

void test('a commit batch carries dropStreams, and revision 0 means "must not exist"', () => {
  const valid = accepts(commitBatchSchema);

  assert.ok(
    valid({
      expect: [{ type: 'a.doc/v1', id: 'x', revision: 0 }],
      put: [{ type: 'a.doc/v1', id: 'x', value: { n: 1 } }],
      dropStreams: ['a.log/x'],
      truncate: { stream: 'a.log/y', afterSequence: 0 },
      append: [{ stream: 'a.log/y', expectedSequence: 0, events: [{}] }],
    }),
  );
  assert.equal(
    valid({ expect: [{ type: 'a.doc/v1', id: 'x', revision: -1 }] }),
    false,
  );
  assert.equal(
    valid({ truncate: { stream: 'a.log/y', afterSequence: -1 } }),
    false,
  );
  assert.equal(
    valid({
      append: [{ stream: 'a.log/y', expectedSequence: -1, events: [1] }],
    }),
    false,
  );
  assert.equal(valid({ append: [{ stream: 'a.log/y', events: [] }] }), false);
  assert.equal(valid({ drop: ['a.log/x'] }), false);
});

void test('stream entries carry the protocol createdAt and pages carry truncation marks', () => {
  assert.ok(
    accepts(streamEntrySchema)({
      sequence: 1,
      value: {},
      createdAt: '2026-10-09T12:00:00.000Z',
    }),
  );
  assert.equal(accepts(streamEntrySchema)({ sequence: 1, value: {} }), false);
  assert.equal(
    accepts(streamEntrySchema)({ sequence: 0, value: {}, createdAt: 'x' }),
    false,
  );

  const page = {
    entries: [],
    lastSequence: 7,
    truncations: [{ afterSequence: 2, atSequence: 7 }],
  };

  assert.ok(accepts(streamPageSchema)(page));
  assert.equal(
    accepts(streamPageSchema)({ entries: [], lastSequence: 7 }),
    false,
  );
  assert.equal(accepts(streamPageSchema)({ ...page, lastSequence: -1 }), false);
});

void test('stream reads start at 0 and queries are bounded to 1000 items', () => {
  const read = accepts(streamReadSchema);
  const query = (limit: number) =>
    accepts(storageQuerySchema)({
      type: 'a.doc/v1',
      index: 'byName',
      equals: [],
      limit,
    });

  assert.ok(read({ stream: 'a.log/x', afterSequence: 0, limit: 1 }));
  assert.equal(read({ stream: 'a.log/x', afterSequence: -1, limit: 1 }), false);
  assert.ok(query(1000));
  assert.equal(query(1001), false);
});

void test('health reports measurements, never a pressure verdict', () => {
  const health = accepts(storageHealthSchema);

  assert.ok(
    health({
      status: 'ok',
      writable: true,
      disk: { blocks: 2 ** 40, availableBlocks: 2 ** 36 },
    }),
  );
  assert.ok(
    health({ status: 'unavailable', writable: false, reason: 'statfs failed' }),
  );
  assert.equal(health({ status: 'pressure', writable: true }), false);
  assert.equal(
    health({ status: 'ok', writable: true, disk: { blocks: '10' } }),
    false,
  );
  assert.equal(
    health({
      status: 'ok',
      writable: true,
      disk: { blocks: 10, availableBlocks: -1 },
    }),
    false,
  );
});

void test('a storage identity is a UUID host ID with a positive generation', () => {
  const identity = accepts(storageIdentitySchema);

  assert.ok(identity({ hostId: uuid, storageGeneration: 1 }));
  assert.equal(identity({ hostId: 'host-1', storageGeneration: 1 }), false);
  assert.equal(identity({ hostId: uuid, storageGeneration: 0 }), false);
});

void test('a feed commit tells appends, truncations and dropped streams apart', () => {
  const commit = {
    position: 1,
    documents: [{ type: 'a.doc/v1', id: 'x' }],
    streams: ['a.log/x'],
    truncated: ['a.log/y'],
    dropped: ['a.log/z'],
  };

  assert.ok(accepts(feedPageSchema)({ commits: [commit] }));
  assert.equal(
    accepts(feedPageSchema)({
      commits: [{ position: 1, documents: [], streams: [] }],
    }),
    false,
  );
});

void test('storage/v1 providers implement health and backends implement identity', async () => {
  assert.throws(
    () =>
      createTestServices({
        bundle: { id: 'consumer' },
        provide: [basicProvider(StorageV1.id, storageMethods, {}, ['health'])],
      }),
    codeOf('contract_mismatch'),
  );
  assert.throws(
    () =>
      createTestServices({
        bundle: { id: 'consumer' },
        provide: [
          basicProvider(StorageBackendV1.id, storageBackendMethods, {}, [
            'identity',
          ]),
        ],
      }),
    codeOf('contract_mismatch'),
  );

  const services = createTestServices({
    bundle: { id: 'consumer' },
    provide: [
      basicProvider(StorageV1.id, storageMethods, {
        health: async () => ({ status: 'pressure', writable: true }),
      }),
      basicProvider(StorageBackendV1.id, storageBackendMethods, {
        identity: async () => ({ hostId: uuid, storageGeneration: 1 }),
      }),
    ],
  });

  await assert.rejects(
    services.services.use(StorageV1).health(),
    codeOf('invalid_output'),
  );
  assert.deepEqual(await services.services.use(StorageBackendV1).identity(), {
    hostId: uuid,
    storageGeneration: 1,
  });

  await services.dispose();
});

// secrets/v1 ------------------------------------------------------------------

const view: SecretsView = {
  list: () => [{ id: 'c1', kind: 'API_TOKEN', name: 'openai', secret: 's1' }],
  redactions: () => ['s1'],
  addRedaction: () => undefined,
};

const secretsFixture = () => {
  const received: { input: unknown; aborted: boolean | undefined }[] = [];
  const signal = new AbortController().signal;
  const services = createTestServices({
    bundle: { id: 'consumer' },
    provide: [
      basicProvider(SecretsV1.id, secretsMethods, {
        resolveByKind: (input: never, call) => {
          received.push({ input, aborted: call.signal.aborted });

          return undefined;
        },
        redactions: () => ['s1', 'added'],
        registerReferences: (source: never) => {
          received.push({
            input: [...(source as () => Iterable<string>)()],
            aborted: undefined,
          });

          return { dispose: () => undefined };
        },
        view: () => view,
      }),
    ],
  });

  return { services, received, signal };
};

void test('resolveByKind takes a kind, optional exclusions and an optional call', async () => {
  const { services, received, signal } = secretsFixture();
  const secrets = services.services.use(SecretsV1);

  await secrets.resolveByKind('API_TOKEN');
  await secrets.resolveByKind('API_TOKEN', { exclude: ['c1'] });
  await secrets.resolveByKind('GIT', undefined, services.call());
  await secrets.resolveByKind('GIT', { exclude: [] }, { signal });
  // A lone call-options object is the call, not the exclusions.
  await secrets.resolveByKind('GIT', { signal } as never);

  assert.deepEqual(
    received.map(({ input }) => input),
    [
      ['API_TOKEN'],
      ['API_TOKEN', { exclude: ['c1'] }],
      ['GIT', undefined],
      ['GIT', { exclude: [] }],
      ['GIT'],
    ],
  );
  assert.throws(
    () => secrets.resolveByKind('API_TOKEN', { exclude: [1] } as never),
    codeOf('invalid_input'),
  );
  assert.throws(
    () => secrets.resolveByKind('API_TOKEN', { claimed: ['c1'] } as never),
    codeOf('invalid_input'),
  );
  assert.throws(
    () => secrets.resolveByKind('SSH_KEY' as never),
    codeOf('invalid_input'),
  );

  await services.dispose();
});

void test('view and registerReferences stay local; redactions is serializable', async () => {
  const { services, received } = secretsFixture();
  const secrets = services.services.use(SecretsV1);

  assert.equal(secrets.view(), view);
  assert.deepEqual(await secrets.redactions(), ['s1', 'added']);

  const registration = secrets.registerReferences(() => new Set(['c1']));

  assert.equal(typeof registration.dispose, 'function');
  assert.deepEqual(received.at(-1)?.input, ['c1']);
  assert.throws(
    () => secrets.registerReferences(['c1'] as never),
    codeOf('invalid_input'),
  );

  // The published schema marks the local members; redactions stays JSON.
  const defs = (
    platformSchemaDocuments().get('contracts/secrets/v1.json') as {
      $defs: Record<string, unknown>;
    }
  ).$defs;

  assert.deepEqual(defs['view.output'], { 'x-doric-local': true });
  assert.deepEqual(defs['registerReferences.input'], {
    'x-doric-local': true,
  });
  assert.deepEqual(defs['redactions.output'], {
    type: 'array',
    items: { type: 'string' },
  });

  await services.dispose();
});

void test('a secrets view must expose list, redactions and addRedaction', async () => {
  assert.ok(isSecretsView(view));
  assert.equal(isSecretsView({ list: () => [], redactions: () => [] }), false);
  assert.equal(isSecretsView(null), false);

  const services = createTestServices({
    bundle: { id: 'consumer' },
    provide: [
      basicProvider(SecretsV1.id, secretsMethods, { view: () => ({}) }),
    ],
  });

  assert.throws(
    () => services.services.use(SecretsV1).view(),
    codeOf('invalid_output'),
  );

  await services.dispose();
});

void test('the credential field rule: required fields present, every other field absent', () => {
  const cases: readonly [
    (typeof credentialKinds)[number],
    Record<string, string>,
    boolean,
  ][] = [
    ['API_TOKEN', { secret: 'sk' }, true],
    ['API_TOKEN', { secret: '' }, true],
    ['API_TOKEN', {}, false],
    ['API_TOKEN', { secret: 'sk', username: 'me' }, false],
    ['USERNAME_PASSWORD', { username: 'me', secret: 'pw' }, true],
    ['USERNAME_PASSWORD', { username: 'me' }, false],
    [
      'USERNAME_PASSWORD',
      { username: 'me', secret: 'pw', email: 'a@b.c' },
      false,
    ],
    ['GIT', { username: 'me', email: 'me@example.com' }, true],
    ['GIT', { username: 'me', email: 'me@example.com', secret: 's' }, false],
    ['GIT', { email: 'me@example.com' }, false],
  ];

  for (const [kind, values, expected] of cases) {
    assert.equal(
      credentialFieldsSatisfied(kind, values),
      expected,
      `${kind} ${JSON.stringify(values)}`,
    );
  }

  assert.deepEqual(credentialKinds, ['API_TOKEN', 'USERNAME_PASSWORD', 'GIT']);
});

void test('the credential field rule reads as the API rejection message', () => {
  assert.equal(
    credentialFieldsMessage('API_TOKEN'),
    'A API_TOKEN credential requires secret and carries no other field.',
  );
  assert.equal(
    credentialFieldsMessage('USERNAME_PASSWORD'),
    'A USERNAME_PASSWORD credential requires username, secret and carries no other field.',
  );
  assert.equal(
    credentialFieldsMessage('GIT'),
    'A GIT credential requires username, email and carries no other field.',
  );
});

// settings/v1 and events/v1 -------------------------------------------------

void test('a settings entry carries its write time and the global generation', async () => {
  const entry = {
    value: { a: 1 },
    revision: 3,
    version: '1.0.0',
    updatedAt: '2026-10-09T12:00:00.000Z',
    generation: 9,
  };

  assert.ok(accepts(settingsEntrySchema)(entry));
  assert.equal(
    accepts(settingsEntrySchema)({ value: 1, revision: 1, version: '1.0.0' }),
    false,
  );
  assert.equal(
    accepts(settingsEntrySchema)({ ...entry, revision: 1.5 }),
    false,
  );
  assert.throws(
    () =>
      createTestServices({
        bundle: { id: 'consumer' },
        provide: [basicProvider(SettingsV1.id, settingsMethods, {}, ['entry'])],
      }),
    codeOf('contract_mismatch'),
  );
});

void test('an event sink names its scope keys, unique and within the scope grammar, and every placeholder among them', () => {
  const sink = {
    scopeKeys: ['projectId', 'threadId', 'promptId'],
    stream: 'runtime.thread.events/{threadId}',
    scopeDescription: 'a project, a Thread and a prompt',
  };

  assert.ok(accepts(eventSinkSpecSchema)(sink));
  assert.ok(
    accepts(eventSinkSpecSchema)({ scopeKeys: ['a'], stream: 'x.y/z' }),
  );
  // A placeholder that is not a scope key, a repeated key, a key outside the
  // grammar, an empty key list and an extra field are all refused.
  assert.equal(
    accepts(eventSinkSpecSchema)({ ...sink, stream: 'runtime.x/{other}' }),
    false,
  );
  assert.equal(
    accepts(eventSinkSpecSchema)({
      ...sink,
      scopeKeys: ['threadId', 'threadId'],
    }),
    false,
  );
  assert.equal(
    accepts(eventSinkSpecSchema)({ ...sink, scopeKeys: ['9lives'] }),
    false,
  );
  assert.equal(accepts(eventSinkSpecSchema)({ ...sink, scopeKeys: [] }), false);
  assert.equal(accepts(eventSinkSpecSchema)({ ...sink, extra: true }), false);
  assert.equal(
    accepts(eventSinkSpecSchema)({
      ...sink,
      scopeKeys: Array.from({ length: 17 }, (_, index) => `key${index}`),
    }),
    false,
  );
});

// errors and catalog ----------------------------------------------------------

void test('storage, settings, events and secrets codes are platform error codes', () => {
  const expected: readonly ContractErrorCode[] = [
    'revision_conflict',
    'sequence_conflict',
    'unique_conflict',
    'limit_exceeded',
    'unknown_type',
    'invalid_index_value',
    'invalid_stream',
    'unknown_settings',
    'settings_missing',
    'settings_conflict',
    'unknown_event',
    'invalid_scope',
    'credential_missing',
    'credential_invalid',
    'credential_name_taken',
    'credential_kind_immutable',
    'credential_ambiguous',
    'credential_storage_unavailable',
    'credential_key_required',
    'credential_unreadable',
  ];

  for (const code of expected) {
    assert.ok(contractErrorCodes.includes(code), code);
  }
});

void test('a catalog snapshot may carry the storage identity', () => {
  const snapshot: CatalogSnapshot = {
    generation: 1,
    composition: { core: 'core', enabled: ['core'], providers: {} },
    bundles: [],
    order: [],
    contracts: [],
  };

  assert.ok(accepts(catalogSnapshotSchema)(snapshot));
  assert.ok(
    accepts(catalogSnapshotSchema)({
      ...snapshot,
      storage: { hostId: uuid, storageGeneration: 2 },
    }),
  );
  assert.equal(
    accepts(catalogSnapshotSchema)({
      ...snapshot,
      storage: { hostId: 'nope', storageGeneration: 2 },
    }),
    false,
  );
});
