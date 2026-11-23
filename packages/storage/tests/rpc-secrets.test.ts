// `secrets.backend/v1` over the router (spec `docs/designs/grpc-processes.md`,
// section 17, "Storage until phase 4"): the secrets cases of
// `memory-backends.test.ts` against the memory secrets backend served by
// `serveSecretsBackend` through `createTestRouter` and called through
// `secretsBackendClient`.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { createTestServices } from 'bundle';
import {
  isContractError,
  type SecretsBackend,
  SecretsBackendV1,
  type StoredSecret,
} from 'bundle/contracts';

import {
  type MemorySecretsOptions,
  memorySecretsBackend,
} from '../src/memory/index.js';
import { serveSecrets } from './support/router-harness.js';

const isCode = (code: string) => (error: unknown) => {
  assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
  assert.equal(error.code, code, error.message);

  return true;
};

/** The memory secrets backend, served through the router, as a client. */
const openSecrets = async (
  t: TestContext,
  options?: MemorySecretsOptions,
): Promise<SecretsBackend> => {
  const harness = createTestServices({
    bundle: { id: 'secrets-test' },
    provide: [memorySecretsBackend(options)],
  });

  t.after(() => harness.dispose());

  const served = await serveSecrets(harness.services.use(SecretsBackendV1));

  t.after(() => served.stop());

  return served.backend;
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

const gitSecret = (id: string, name: string): StoredSecret => {
  const { secret: _secret, ...row } = secret(id, name, {
    kind: 'GIT',
    username: 'u',
    email: 'e',
  });

  return row;
};

void test('secrets are upserted by ID and listed by name over the router', async (t) => {
  const backend = await openSecrets(t);

  await backend.put(secret('1', 'openrouter'));
  await backend.put(secret('2', 'Anthropic'));
  await backend.put(gitSecret('3', 'github'));
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

  const git = fieldsOf((await backend.get('3')) as StoredSecret);

  assert.deepEqual(git, {
    id: '3',
    kind: 'GIT',
    name: 'github',
    username: 'u',
    email: 'e',
  });
  assert.ok(!('secret' in git), 'an absent secret is no key');
});

void test('get of a missing secret is undefined; delete answers deleted then missing', async (t) => {
  const backend = await openSecrets(t);

  assert.equal(await backend.get('missing'), undefined);

  await backend.put(secret('1', 'openrouter'));
  assert.equal(await backend.delete('1'), 'deleted');
  assert.equal(await backend.delete('1'), 'missing');
  assert.equal(await backend.get('1'), undefined);
});

void test('an update keeps the stored kind and drops fields it no longer carries', async (t) => {
  const backend = await openSecrets(t);

  await backend.put(
    secret('1', 'login', { kind: 'USERNAME_PASSWORD', username: 'octocat' }),
  );
  await backend.put(secret('1', 'login', { kind: 'API_TOKEN' }));

  const stored = (await backend.get('1')) as StoredSecret;

  assert.equal(stored.kind, 'USERNAME_PASSWORD');
  assert.ok(!('username' in stored), 'username is absent, not undefined');
});

void test('credential_name_taken crosses with its code', async (t) => {
  const backend = await openSecrets(t);

  await backend.put(secret('1', 'shared'));
  await backend.put(gitSecret('2', 'shared'));
  await assert.rejects(
    backend.put(secret('3', 'shared')),
    isCode('credential_name_taken'),
  );
  assert.equal((await backend.get('1'))?.name, 'shared');
});

void test('credential_storage_unavailable and credential_key_required cross with their codes', async (t) => {
  const backend = await openSecrets(t, {
    keyConfigured: false,
    rows: [gitSecret('git', 'identity')],
  });

  for (const value of ['token', '']) {
    await assert.rejects(
      backend.put(secret('1', 'openrouter', { secret: value })),
      isCode('credential_storage_unavailable'),
    );
  }

  await backend.put(gitSecret('2', 'identity-2'));
  assert.deepEqual(
    (await backend.list()).map(({ id }) => id),
    ['git', '2'],
  );

  const held = await openSecrets(t, {
    keyConfigured: false,
    rows: [secret('1', 'openrouter'), secret('2', 'empty', { secret: '' })],
  });

  await assert.rejects(held.list(), isCode('credential_key_required'));
  await assert.rejects(held.get('1'), isCode('credential_key_required'));
  assert.equal((await held.get('2'))?.secret, '', 'an empty secret stays ""');
});
