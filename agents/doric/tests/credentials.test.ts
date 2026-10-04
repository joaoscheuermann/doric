import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type Credential,
  CredentialCreateSchema,
  credentialFields,
  credentialFieldsSatisfied,
  CredentialUpdateSchema,
  publicCredential,
} from '../src/lib/credentials/kind.js';
import {
  AmbiguousCredentialError,
  credentialById,
  credentialByKind,
  MissingCredentialError,
} from '../src/lib/credentials/resolve.js';
import { createSecretCipher } from '../src/lib/credentials/secret.js';
import { createCredentialService } from '../src/lib/credentials/service.js';
import type {
  CredentialRow,
  CredentialStore,
  StoredCredential,
} from '../src/lib/credentials/store.js';

const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const apiToken = (secret?: string): Credential => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'openrouter',
  ...(secret === undefined ? {} : { secret }),
});

/** One in-memory `credential` table with the same row shape and uniqueness. */
const memoryStore = (rows: StoredCredential[] = []) => {
  const store: CredentialStore = {
    list: async () => rows,
    create: async (row: CredentialRow) => {
      const stored = { id: `id-${rows.length}`, ...row };
      rows.push(stored);
      return stored;
    },
    update: async (id, row) => {
      const stored = rows.find((candidate) => candidate.id === id);
      if (stored === undefined) return undefined;
      Object.assign(stored, row);
      return stored;
    },
    remove: async (id) => {
      const index = rows.findIndex((candidate) => candidate.id === id);
      if (index === -1) return 'missing';
      rows.splice(index, 1);
      return 'deleted';
    },
  };
  return { store, rows };
};

void test('satisfies exactly the field set of each kind', () => {
  assert.deepEqual(credentialFields('API_TOKEN'), {
    required: ['secret'],
    optional: [],
  });
  assert.deepEqual(credentialFields('USERNAME_PASSWORD'), {
    required: ['username', 'secret'],
    optional: [],
  });
  assert.deepEqual(credentialFields('GIT'), {
    required: ['username', 'email'],
    optional: [],
  });
});

void test('rejects a value the kind forbids and accepts the ones it requires', () => {
  const cases = [
    { kind: 'API_TOKEN' as const, values: {}, accepted: false },
    { kind: 'API_TOKEN' as const, values: { secret: 'x' }, accepted: true },
    {
      kind: 'API_TOKEN' as const,
      values: { secret: 'x', username: 'octocat' },
      accepted: false,
    },
    {
      kind: 'API_TOKEN' as const,
      values: { secret: 'x', email: 'a@example.com' },
      accepted: false,
    },
    {
      kind: 'USERNAME_PASSWORD' as const,
      values: { username: 'octocat' },
      accepted: false,
    },
    {
      kind: 'USERNAME_PASSWORD' as const,
      values: { username: 'octocat', secret: 'x' },
      accepted: true,
    },
    {
      kind: 'USERNAME_PASSWORD' as const,
      values: { username: 'octocat', secret: 'x', email: 'a@example.com' },
      accepted: false,
    },
    { kind: 'GIT' as const, values: { username: 'octocat' }, accepted: false },
    {
      kind: 'GIT' as const,
      values: { username: 'octocat', email: 'a@example.com' },
      accepted: true,
    },
    {
      kind: 'GIT' as const,
      values: {
        username: 'octocat',
        email: 'a@example.com',
        secret: 'x',
      },
      accepted: false,
    },
  ];

  for (const { kind, values, accepted } of cases)
    assert.equal(
      credentialFieldsSatisfied(kind, values),
      accepted,
      `${kind} with ${JSON.stringify(values)}`,
    );
});

void test('validates a create body against the kind it names', () => {
  const cases = [
    { body: { kind: 'API_TOKEN', name: 'key', secret: 'x' }, accepted: true },
    { body: { kind: 'API_TOKEN', name: 'key' }, accepted: false },
    {
      body: {
        kind: 'API_TOKEN',
        name: 'key',
        secret: 'x',
        username: 'octocat',
      },
      accepted: false,
    },
    {
      body: { kind: 'USERNAME_PASSWORD', name: 'key', username: 'octocat' },
      accepted: false,
    },
    {
      body: {
        kind: 'USERNAME_PASSWORD',
        name: 'key',
        username: 'octocat',
        secret: 'x',
      },
      accepted: true,
    },
    {
      body: {
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
        secret: 'x',
      },
      accepted: false,
    },
    {
      body: {
        kind: 'GIT',
        name: 'github',
        username: 'octocat',
        email: 'octocat@example.com',
      },
      accepted: true,
    },
    {
      body: { kind: 'GIT', name: 'github', username: 'octocat', email: 'nope' },
      accepted: false,
    },
    { body: { kind: 'OTHER', name: 'key', secret: 'x' }, accepted: false },
  ];

  for (const { body, accepted } of cases)
    assert.equal(
      CredentialCreateSchema.safeParse(body).success,
      accepted,
      JSON.stringify(body),
    );
});

void test('accepts the clear, keep, and set forms on a patch', () => {
  for (const body of [
    {},
    { secret: null },
    { secret: '' },
    { secret: 'x' },
    { name: 'renamed' },
  ])
    assert.equal(
      CredentialUpdateSchema.safeParse(body).success,
      true,
      JSON.stringify(body),
    );
});

void test('resolves the single credential of a requested kind', () => {
  const only = apiToken('x');

  assert.deepEqual(credentialByKind([], 'API_TOKEN'), undefined);
  assert.deepEqual(credentialByKind([only], 'API_TOKEN'), only);
  assert.deepEqual(credentialByKind([only], 'GIT'), undefined);
});

void test('refuses to guess when several credentials share a kind', () => {
  const first = apiToken('x');
  const second = {
    ...apiToken('y'),
    id: '00000000-0000-4000-8000-000000000002',
  };

  assert.throws(
    () => credentialByKind([first, second], 'API_TOKEN'),
    (error: unknown) =>
      error instanceof AmbiguousCredentialError &&
      error.message.includes('API_TOKEN'),
  );
});

void test('resolves an explicit reference and rejects a broken one', () => {
  const only = apiToken('x');

  assert.deepEqual(credentialById([only], only.id), only);
  assert.throws(
    () => credentialById([only], '00000000-0000-4000-8000-00000000009f'),
    MissingCredentialError,
  );
});

void test('wraps a secret in a versioned envelope that only its key opens', () => {
  const cipher = createSecretCipher(key);
  assert.ok(cipher);

  const envelope = cipher.encrypt('super-secret');
  assert.match(envelope, /^v1:/u);
  assert.equal(envelope.includes('super-secret'), false);
  assert.equal(cipher.decrypt(envelope), 'super-secret');
  assert.notEqual(cipher.encrypt('super-secret'), envelope);
  assert.equal(cipher.encrypt(''), '');
  assert.equal(cipher.decrypt(''), '');

  const other = createSecretCipher(
    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  );
  assert.throws(() => other?.decrypt(envelope));
  assert.throws(() => cipher.decrypt('not-an-envelope'));
  assert.throws(() => cipher.decrypt('v2:a:b:c'));
});

void test('refuses an unusable key and reports an absent one', () => {
  assert.equal(createSecretCipher(undefined), undefined);
  assert.equal(createSecretCipher('  '), undefined);
  assert.throws(() => createSecretCipher('short'));
  assert.throws(() => createSecretCipher('!'.repeat(44)));
});

void test('stores the secret encrypted and answers it only to the host', async () => {
  const memory = memoryStore();
  const service = await createCredentialService({
    store: memory.store,
    environment: { DORIC_CREDENTIAL_KEY: key },
  });

  const created = await service.create({
    kind: 'API_TOKEN',
    name: 'openrouter',
    secret: 'sk_secret',
  });

  assert.equal(created.status, 'saved');
  assert.equal(memory.rows[0]?.secret?.startsWith('v1:'), true);
  assert.equal(memory.rows[0]?.secret?.includes('sk_secret'), false);
  assert.deepEqual(service.secrets(), ['sk_secret']);
  assert.equal(service.byId(memory.rows[0].id).secret, 'sk_secret');

  // The API view never carries the secret itself.
  const view = publicCredential(service.list()[0]);
  assert.deepEqual(view, {
    id: memory.rows[0].id,
    kind: 'API_TOKEN',
    name: 'openrouter',
    hasSecret: true,
  });
  assert.equal(JSON.stringify(view).includes('sk_secret'), false);
});

void test('refuses to start when a stored secret has no key', async () => {
  const memory = memoryStore([
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'API_TOKEN',
      name: 'openrouter',
      username: null,
      email: null,
      secret: 'v1:AAAA:BBBB:CCCC',
    },
  ]);

  await assert.rejects(
    createCredentialService({ store: memory.store, environment: {} }),
  );
  // A row without a secret is not a reason to refuse to start.
  const empty = memoryStore([
    {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'API_TOKEN',
      name: 'openrouter',
      username: null,
      email: null,
      secret: '',
    },
  ]);
  const service = await createCredentialService({
    store: empty.store,
    environment: {},
  });
  assert.equal(service.list()[0]?.secret, '');
  assert.deepEqual(service.secrets(), []);
});

/** A secret the host wrote into a sandbox is redacted like a stored one. */
void test('redacts a secret it learned after the store was read', async () => {
  const empty = memoryStore([]);
  const service = await createCredentialService({
    store: empty.store,
    environment: {},
  });
  const learned = 'ghp_learned_in_a_sandbox';

  assert.deepEqual(service.secrets(), []);

  service.register(learned);
  // An empty secret is no secret, exactly as the store's own rule reads it.
  service.register('');

  assert.deepEqual(service.secrets(), [learned]);
});

void test('keeps, clears, and sets a stored field through one rule', async () => {
  const memory = memoryStore();
  const service = await createCredentialService({
    store: memory.store,
    environment: { DORIC_CREDENTIAL_KEY: key },
  });
  await service.create({
    kind: 'GIT',
    name: 'github',
    username: 'octocat',
    email: 'octocat@example.com',
  });
  const id = service.list()[0].id;

  // An absent or null field keeps the stored value; a value sets it.
  const kept = await service.update(id, { name: 'renamed' });
  assert.equal(kept.status, 'saved');
  assert.deepEqual(service.byId(id), {
    id,
    kind: 'GIT',
    name: 'renamed',
    username: 'octocat',
    email: 'octocat@example.com',
  });

  const cleared = await service.update(id, { email: '' });
  assert.equal(cleared.status, 'saved');
  assert.equal(service.byId(id).email, '');

  // A field the kind forbids is rejected, and so is a changed kind.
  const forbidden = await service.update(id, { secret: 'x' });
  assert.equal(forbidden.status, 'invalid');
  if (forbidden.status === 'invalid') assert.match(forbidden.message, /GIT/u);
  assert.equal(
    (await service.update(id, { kind: 'API_TOKEN' })).status,
    'immutable',
  );
  assert.equal(
    (await service.update('missing', { name: 'x' })).status,
    'missing',
  );
});

void test('keeps a provider key out of an unclaimed-kind fallback', async () => {
  const memory = memoryStore();
  const service = await createCredentialService({
    store: memory.store,
    environment: { DORIC_CREDENTIAL_KEY: key },
  });
  const providerKey = await service.create({
    kind: 'API_TOKEN',
    name: 'openrouter',
    secret: 'sk_provider',
  });
  if (providerKey.status !== 'saved') throw new Error('expected a saved row');

  // The only API_TOKEN is the provider's key, so an integration that merely asks
  // for that kind by fallback finds nothing rather than authenticating with it.
  assert.equal(service.byKind('API_TOKEN')?.secret, 'sk_provider');
  assert.equal(
    service.byUnclaimedKind('API_TOKEN', new Set([providerKey.credential.id])),
    undefined,
  );

  const github = await service.create({
    kind: 'API_TOKEN',
    name: 'github',
    secret: 'ghp_token',
  });
  if (github.status !== 'saved') throw new Error('expected a saved row');

  assert.equal(
    service.byUnclaimedKind('API_TOKEN', new Set([providerKey.credential.id]))
      ?.secret,
    'ghp_token',
  );
});

void test('stops resolving a credential once it is deleted', async () => {
  const memory = memoryStore();
  const service = await createCredentialService({
    store: memory.store,
    environment: { DORIC_CREDENTIAL_KEY: key },
  });
  await service.create({
    kind: 'API_TOKEN',
    name: 'openrouter',
    secret: 'sk_secret',
  });
  const id = service.list()[0].id;

  assert.equal(await service.remove(id), 'deleted');
  assert.equal(service.find(id), undefined);
  assert.equal(service.byKind('API_TOKEN'), undefined);
  assert.deepEqual(service.secrets(), []);
  assert.equal(await service.remove(id), 'missing');
});

void test('applies the field rule to a create the route did not check', async () => {
  const memory = memoryStore();
  const service = await createCredentialService({
    store: memory.store,
    environment: { DORIC_CREDENTIAL_KEY: key },
  });

  const rejected = await service.create({
    kind: 'GIT',
    name: 'github',
    username: 'octocat',
    email: 'octocat@example.com',
    secret: 'x',
  });

  assert.equal(rejected.status, 'invalid');
  assert.deepEqual(memory.rows, []);

  const accepted = await service.create({
    kind: 'GIT',
    name: 'github',
    username: 'octocat',
    email: 'octocat@example.com',
  });
  assert.equal(accepted.status, 'saved');
});

void test('refuses to write a secret without a key', async () => {
  const memory = memoryStore();
  const service = await createCredentialService({
    store: memory.store,
    environment: {},
  });

  await assert.rejects(
    service.create({ kind: 'API_TOKEN', name: 'key', secret: 'x' }),
  );
  // A kind that carries no secret still works.
  const identity = await service.create({
    kind: 'GIT',
    name: 'github',
    username: 'octocat',
    email: 'octocat@example.com',
  });
  assert.equal(identity.status, 'saved');
});
