import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from 'llms';

import {
  frozenKind,
  providerWorld,
  recordingTransport,
} from './support/world.js';

void test('the openai record answers the frozen llms kind, is advertised and reports no catalog capacity', async () => {
  const { world, provider } = await providerWorld('openai');

  try {
    assert.deepEqual(await provider.kind(), frozenKind());
    assert.equal(await provider.advertised(), true);
    assert.equal(await provider.catalogCapacity(), false);
  } finally {
    await world.dispose();
  }
});

void test('openai keeps no models URL, so its catalog is absent without a request', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('openai', { transport });

  try {
    assert.deepEqual(
      await provider.catalog({
        configuration: { endpoint: 'https://work.test/v1' },
        secret: 'sk',
      }),
      { status: 'absent' },
    );
    assert.equal(requests.length, 0);
  } finally {
    await world.dispose();
  }
});

void test('create uses the provider id as identity, logs through log/v1 and omits auth without a secret', async () => {
  const { requests, transport } = recordingTransport();
  const { world, lines, provider } = await providerWorld('openai', {
    transport,
  });

  try {
    const built = (await provider.create({
      providerId: 'work',
      values: { endpoint: 'https://work.test/v1' },
    })) as unknown as LlmProvider & { kind: string };

    assert.deepEqual(built.metadata, {
      id: 'work',
      name: 'work',
      baseUrl: 'https://work.test/v1',
    });
    assert.equal(built.kind, 'openai');
    assert.deepEqual(lines[0], {
      level: 'debug',
      message: 'llm provider initialized',
      fields: { component: 'llms', provider: 'work' },
    });

    await built.models();
    assert.equal(requests.at(-1)?.url, 'https://work.test/v1/models');
    assert.equal(requests.at(-1)?.headers?.authorization, undefined);
  } finally {
    await world.dispose();
  }
});

void test('without an endpoint the provider uses the kind default base URL', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('openai', { transport });

  try {
    const built = (await provider.create({
      providerId: 'work',
      values: {},
    })) as unknown as LlmProvider;

    await built.models();
    assert.equal(
      requests.at(-1)?.url,
      `${frozenKind().fields[0]?.placeholder}/models`,
    );
  } finally {
    await world.dispose();
  }
});

void test('the secret source is read before every request, so a rotation reaches the next one', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('openai', { transport });
  let secret = 'first';
  let reads = 0;

  try {
    const built = (await provider.create({
      providerId: 'work',
      values: { endpoint: 'https://work.test/v1' },
      secret: () => {
        reads += 1;

        return Promise.resolve(secret);
      },
    })) as unknown as LlmProvider;

    assert.equal(reads, 0);
    await built.models();
    assert.equal(requests.at(-1)?.headers?.authorization, 'Bearer first');
    secret = 'rotated';
    await built.models();
    assert.equal(requests.at(-1)?.headers?.authorization, 'Bearer rotated');
    assert.equal(reads, 2);
  } finally {
    await world.dispose();
  }
});
