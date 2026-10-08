import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import type { Credential } from '../src/lib/credentials/kind.js';
import { MissingKeyError } from '../src/lib/credentials/secret.js';
import type { CredentialService } from '../src/lib/credentials/service.js';
import { createCredentialsRouter } from '../src/routes/credentials.js';

const id = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const secret = 'sk_private_value';
const stored: Credential = {
  id,
  kind: 'API_TOKEN',
  name: 'openrouter',
  secret,
};

void test('answers every credential without its secret', async () => {
  const host = await serve({ list: () => [stored] });

  try {
    const response = await fetch(`${host.url}/credentials`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(body.includes(secret), false);
    assert.deepEqual(JSON.parse(body), [
      {
        id,
        kind: 'API_TOKEN',
        name: 'openrouter',
        hasSecret: true,
      },
    ]);
  } finally {
    await host.close();
  }
});

void test('creates a credential and answers it without the secret', async () => {
  let received: unknown;
  const host = await serve({
    create: async (input) => {
      received = input;

      return { status: 'saved', credential: { ...stored, name: input.name } };
    },
  });

  try {
    const response = await fetch(`${host.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'API_TOKEN',
        name: 'openrouter',
        secret,
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 201);
    assert.equal(JSON.stringify(received ?? '').includes(secret), true);
    assert.equal(body.includes(secret), false);
    assert.equal((JSON.parse(body) as { hasSecret: boolean }).hasSecret, true);
  } finally {
    await host.close();
  }
});

void test('rejects a create body that does not match its kind', async () => {
  let creates = 0;
  const host = await serve({
    create: async () => {
      creates += 1;

      return { status: 'saved', credential: stored };
    },
  });

  try {
    for (const body of [
      { kind: 'API_TOKEN', name: 'openrouter' },
      { kind: 'GIT', name: 'github', username: 'octocat', secret },
      { kind: 'GIT', name: 'github', username: 'octocat', email: 'nope' },
      { kind: 'OTHER', name: 'openrouter', secret },
    ]) {
      const response = await fetch(`${host.url}/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      assert.equal(response.status, 422, JSON.stringify(body));
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'invalid_credential',
      );
    }
    assert.equal(creates, 0);
  } finally {
    await host.close();
  }
});

void test('updates a credential and reports the shared failures', async () => {
  const host = await serve({
    update: async (_id, input) => {
      if (input.kind !== undefined) return { status: 'immutable' };
      if (input.name === 'taken') return { status: 'conflict' };
      if (input.name === 'empty')
        return {
          status: 'invalid',
          message:
            'A GIT credential requires username, email and carries no other field.',
        };

      return {
        status: 'saved',
        credential: { ...stored, name: input.name ?? stored.name },
      };
    },
  });

  try {
    const updated = await patch(host, id, { name: 'renamed' });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { name: string }).name, 'renamed');

    assert.equal((await patch(host, id, { kind: 'GIT' })).status, 409);
    assert.equal((await patch(host, id, { name: 'taken' })).status, 409);
    assert.equal((await patch(host, id, { name: 'empty' })).status, 422);
    assert.equal((await patch(host, 'not-an-id', { name: 'x' })).status, 400);
  } finally {
    await host.close();
  }
});

void test('reports a credential that was never stored as missing', async () => {
  const host = await serve({ update: async () => ({ status: 'missing' }) });

  try {
    const response = await patch(host, id, { name: 'x' });

    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'credential_not_found',
    );
  } finally {
    await host.close();
  }
});

void test('refuses to delete a credential a provider or the configuration uses', async () => {
  const host = await serve({
    remove: async (target) => (target === id ? 'referenced' : 'deleted'),
  });

  try {
    const referenced = await fetch(`${host.url}/credentials/${id}`, {
      method: 'DELETE',
    });
    assert.equal(referenced.status, 409);
    assert.equal(
      ((await referenced.json()) as { error: { code: string } }).error.code,
      'credential_referenced',
    );

    const deleted = await fetch(
      `${host.url}/credentials/${id.replace('1601', '1602')}`,
      { method: 'DELETE' },
    );
    assert.equal(deleted.status, 204);
  } finally {
    await host.close();
  }
});

void test('reports a delete for a credential that was never stored', async () => {
  const host = await serve({ remove: async () => 'missing' });

  try {
    const response = await fetch(`${host.url}/credentials/${id}`, {
      method: 'DELETE',
    });

    assert.equal(response.status, 404);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'credential_not_found',
    );
  } finally {
    await host.close();
  }
});

void test('answers an unusable host key as an unavailable store', async () => {
  const host = await serve({
    create: async () => {
      throw new MissingKeyError();
    },
  });

  try {
    const response = await fetch(`${host.url}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'API_TOKEN', name: 'key', secret }),
    });

    assert.equal(response.status, 503);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'credential_storage_unavailable',
    );
  } finally {
    await host.close();
  }
});

const patch = async (
  host: { readonly url: string },
  target: string,
  body: unknown,
): Promise<Response> =>
  fetch(`${host.url}/credentials/${target}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const serve = async (service: Partial<CredentialService>) => {
  const app = express();
  app.use(express.json());
  app.use('/credentials', createCredentialsRouter(service as never));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      ),
  };
};
