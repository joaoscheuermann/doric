import assert from 'node:assert/strict';
import test from 'node:test';

import {
  builtinCredentialKinds,
  type CredentialKindDefinition,
  credentialFieldsMessage,
  credentialFieldsSatisfied,
} from 'bundle/contracts';

import type { Credential } from '../src/host/credentials/kind.js';
import {
  AmbiguousCredentialError,
  credentialById,
  credentialByKind,
  MissingCredentialError,
} from '../src/host/credentials/resolve.js';

// The `GIT` kind is registered by the git bundle; its definition is spelled out
// here because this bundle does not depend on git.
const git: CredentialKindDefinition = {
  id: 'GIT',
  required: ['username', 'email'],
  optional: [],
};

const definitionOf = (id: string): CredentialKindDefinition => {
  const found = [...builtinCredentialKinds, git].find(
    (definition) => definition.id === id,
  );

  if (found === undefined) throw new Error(`No ${id} definition.`);
  return found;
};

const apiToken = (secret?: string): Credential => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'openrouter',
  ...(secret === undefined ? {} : { secret }),
});

void test('defines the built-in kinds with their field sets', () => {
  assert.deepEqual(definitionOf('API_TOKEN'), {
    id: 'API_TOKEN',
    required: ['secret'],
    optional: [],
  });
  assert.deepEqual(definitionOf('USERNAME_PASSWORD'), {
    id: 'USERNAME_PASSWORD',
    required: ['username', 'secret'],
    optional: [],
  });
});

void test('rejects a value the kind forbids and accepts the ones it requires', () => {
  const cases = [
    { kind: 'API_TOKEN', values: {}, accepted: false },
    { kind: 'API_TOKEN', values: { secret: 'x' }, accepted: true },
    {
      kind: 'API_TOKEN',
      values: { secret: 'x', username: 'octocat' },
      accepted: false,
    },
    {
      kind: 'API_TOKEN',
      values: { secret: 'x', email: 'a@example.com' },
      accepted: false,
    },
    {
      kind: 'USERNAME_PASSWORD',
      values: { username: 'octocat' },
      accepted: false,
    },
    {
      kind: 'USERNAME_PASSWORD',
      values: { username: 'octocat', secret: 'x' },
      accepted: true,
    },
    {
      kind: 'USERNAME_PASSWORD',
      values: { username: 'octocat', secret: 'x', email: 'a@example.com' },
      accepted: false,
    },
    { kind: 'GIT', values: { username: 'octocat' }, accepted: false },
    {
      kind: 'GIT',
      values: { username: 'octocat', email: 'a@example.com' },
      accepted: true,
    },
    {
      kind: 'GIT',
      values: { username: 'octocat', email: 'a@example.com', secret: 'x' },
      accepted: false,
    },
  ];

  for (const { kind, values, accepted } of cases)
    assert.equal(
      credentialFieldsSatisfied(definitionOf(kind), values),
      accepted,
      `${kind} with ${JSON.stringify(values)}`,
    );
});

void test('names the field set of a kind in the rejection message', () => {
  assert.equal(
    credentialFieldsMessage(git),
    'A GIT credential requires username, email and carries no other field.',
  );
  assert.equal(
    credentialFieldsMessage({
      id: 'TOKEN_PAIR',
      required: ['secret'],
      optional: ['username'],
    }),
    'A TOKEN_PAIR credential requires secret and may also carry username.',
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
