// What a server's entries resolve to: plain values as given, credential
// entries through secrets/v1 (and only those), the last entry of a name
// winning, and the MCP_TOKEN kind the bundle registers for OAuth tokens.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CallArg,
  ContractError,
  type CredentialRef,
  type Secret,
} from 'bundle/contracts';

import { mcpTokenKind, resolveEntries } from '../src/host/credentials.js';
import { codeOf } from './support/wait.js';

/** A secrets/v1 `resolve` over fixed credentials, recording what it was asked. */
const secretsOf = (stored: readonly Secret[]) => {
  const asked: { readonly id: string; readonly call?: CallArg }[] = [];

  return {
    asked,
    secrets: {
      resolve: async (ref: CredentialRef, call?: CallArg): Promise<Secret> => {
        asked.push({ id: ref.id, ...(call === undefined ? {} : { call }) });
        const found = stored.find((entry) => entry.id === ref.id);

        if (found === undefined) {
          throw new ContractError(
            'credential_missing',
            `Credential ${ref.id} is not stored.`,
          );
        }

        return found;
      },
    },
  };
};

const token: Secret = {
  id: 'credential-token',
  kind: 'API_TOKEN',
  name: 'docs-token',
  secret: 'resolved-secret',
};

void test('the MCP_TOKEN kind requires a secret and nothing else', () => {
  assert.deepEqual(mcpTokenKind, {
    id: 'MCP_TOKEN',
    required: ['secret'],
    optional: [],
    label: 'MCP token',
  });
});

void test('plain entries resolve as given without reading any credential', async () => {
  const { asked, secrets } = secretsOf([token]);

  const resolved = await resolveEntries(
    [
      { name: 'MODE', value: 'test' },
      { name: 'X-Team', value: 'a' },
    ],
    secrets,
  );

  assert.deepEqual(resolved.values, { MODE: 'test', 'X-Team': 'a' });

  assert.deepEqual(resolved.secrets, []);

  assert.deepEqual(asked, []);
});

void test('a credential entry resolves to its secret under the given call, and the secret is reported', async () => {
  const { asked, secrets } = secretsOf([token]);
  const call: CallArg = { signal: new AbortController().signal };

  const resolved = await resolveEntries(
    [
      { name: 'MODE', value: 'test' },
      { name: 'TOKEN', credentialId: token.id },
    ],
    secrets,
    call,
  );

  assert.deepEqual(resolved.values, { MODE: 'test', TOKEN: 'resolved-secret' });

  assert.ok(resolved.secrets.includes('resolved-secret'));

  assert.deepEqual(
    asked.map((entry) => entry.id),
    [token.id],
  );

  assert.equal(asked[0]?.call, call);
});

void test('the later entry of the same name wins', async () => {
  const { secrets } = secretsOf([token]);

  const credentialLast = await resolveEntries(
    [
      { name: 'TOKEN', value: 'plain' },
      { name: 'TOKEN', credentialId: token.id },
    ],
    secrets,
  );
  const plainLast = await resolveEntries(
    [
      { name: 'TOKEN', credentialId: token.id },
      { name: 'TOKEN', value: 'plain' },
    ],
    secrets,
  );

  assert.deepEqual(credentialLast.values, { TOKEN: 'resolved-secret' });

  assert.deepEqual(plainLast.values, { TOKEN: 'plain' });
});

void test('a credential that cannot be resolved rejects with the secrets/v1 error', async () => {
  const { secrets } = secretsOf([]);

  await assert.rejects(
    resolveEntries([{ name: 'TOKEN', credentialId: 'gone' }], secrets),
    (error: unknown) => {
      assert.equal(codeOf(error), 'credential_missing');
      return true;
    },
  );
});

void test('a credential without a secret is refused as invalid input', async () => {
  const { secrets } = secretsOf([
    {
      id: 'no-secret',
      kind: 'USERNAME_PASSWORD',
      name: 'login',
      username: 'me',
    },
  ]);

  await assert.rejects(
    resolveEntries([{ name: 'TOKEN', credentialId: 'no-secret' }], secrets),
    (error: unknown) => {
      assert.equal(codeOf(error), 'invalid_input');
      return true;
    },
  );
});
