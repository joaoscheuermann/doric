import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type Credential,
  CredentialCreateSchema,
  CredentialUpdateSchema,
  credentialFields,
  credentialFieldsSatisfied,
} from '../src/lib/credentials/kind.js';
import {
  AmbiguousCredentialError,
  credentialById,
  credentialByKind,
  MissingCredentialError,
} from '../src/lib/credentials/resolve.js';

const apiToken = (secret?: string): Credential => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'openrouter',
  ...(secret === undefined ? {} : { secret }),
});

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
