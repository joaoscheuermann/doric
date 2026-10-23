import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from 'llms';

import {
  frozenKind,
  providerWorld,
  recordingTransport,
} from './support/world.js';

void test('the claude record answers the frozen llms kind and is advertised', async () => {
  const { world, provider } = await providerWorld('claude');

  try {
    assert.deepEqual(await provider.kind(), frozenKind());
    assert.equal(await provider.advertised(), true);
    assert.equal(await provider.catalogCapacity(), false);
  } finally {
    await world.dispose();
  }
});

void test('claude keeps no models URL, so its catalog is absent without a request', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('claude', { transport });

  try {
    assert.deepEqual(await provider.catalog({ configuration: {} }), {
      status: 'absent',
    });
    assert.equal(requests.length, 0);
  } finally {
    await world.dispose();
  }
});

void test('claude requires its token', async () => {
  const { world, provider } = await providerWorld('claude');

  try {
    await assert.rejects(
      async () => await provider.create({ providerId: 'cl', values: {} }),
      { message: 'Provider kind claude requires a token value.' },
    );
    await assert.rejects(
      async () =>
        await provider.create({
          providerId: 'cl',
          values: { token: '   ' },
        }),
      { message: 'Provider kind claude requires a token value.' },
    );
  } finally {
    await world.dispose();
  }
});

void test('a built claude provider answers its kind and fields', async () => {
  const { world, provider } = await providerWorld('claude');

  try {
    const built = (await provider.create({
      providerId: 'cl',
      values: { token: 'claude-auth' },
    })) as unknown as LlmProvider & { kind: string; configuration: unknown };

    assert.equal(built.kind, 'claude');
    assert.deepEqual(built.configuration, frozenKind().fields);
  } finally {
    await world.dispose();
  }
});
