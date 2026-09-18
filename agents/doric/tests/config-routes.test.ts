import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { defaultConfig } from '../src/lib/config.js';
import { createConfigRouter } from '../src/routes/config.js';

test('returns the active configuration at the root config route', async () => {
  const active = snapshot(1);

  const host = await serveConfig({
    current: () => ({ snapshot: active }),
  });

  try {
    const current = await fetch(`${host.url}/config`);

    assert.equal(current.status, 200);

    assert.deepEqual(await current.json(), active);
  } finally {
    await host.close();
  }
});

test('replaces the complete configuration at the root config route', async () => {
  let active = snapshot(1);

  const host = await serveConfig({
    current: () => ({ snapshot: active }),
    replace: async (configuration: typeof defaultConfig) => {
      active = { ...snapshot(2), configuration };

      return active;
    },
  });
  const replacement = structuredClone(defaultConfig);

  replacement.models.execution.model = 'replacement';

  try {
    const response = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(replacement),
    });

    assert.equal(response.status, 200);

    assert.deepEqual(await response.json(), {
      ...snapshot(2),
      configuration: replacement,
    });
  } finally {
    await host.close();
  }
});

test('rejects an invalid configuration without activating it', async () => {
  let replacements = 0;

  const host = await serveConfig({
    current: () => ({ snapshot: snapshot(1) }),
    replace: async () => {
      replacements += 1;

      return snapshot(2);
    },
  });

  try {
    const invalid = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...defaultConfig, providers: [] }),
    });

    assert.equal(invalid.status, 422);

    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      'invalid_config',
    );

    assert.equal(replacements, 0);
  } finally {
    await host.close();
  }
});

test('returns a stable error when configuration activation fails', async () => {
  const host = await serveConfig({
    current: () => ({ snapshot: snapshot(1) }),
    replace: async () => {
      throw new Error('provider secret');
    },
  });

  try {
    const response = await fetch(`${host.url}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(defaultConfig),
    });

    assert.equal(response.status, 503);

    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      'configuration_rejected',
    );
  } finally {
    await host.close();
  }
});

const snapshot = (revision: number) => ({
  configuration: defaultConfig,
  revision,
  updatedAt: new Date(revision * 1000).toISOString(),
});

const serveConfig = async (service: unknown) => {
  const app = express();

  app.use(express.json());

  app.use('/config', createConfigRouter(service as never));

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
