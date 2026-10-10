import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from 'llms';

import {
  frozenKind,
  providerWorld,
  recordingTransport,
} from './support/world.js';

void test('the codex record answers the frozen llms kind and is not advertised', async () => {
  const { world, provider } = await providerWorld('codex');

  try {
    assert.deepEqual(await provider.kind(), frozenKind());
    assert.equal(await provider.advertised(), false);
    assert.equal(await provider.catalogCapacity(), false);
  } finally {
    await world.dispose();
  }
});

void test('codex keeps no models URL, so its catalog is absent without a request', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('codex', { transport });

  try {
    assert.deepEqual(await provider.catalog({ configuration: {} }), {
      status: 'absent',
    });
    assert.equal(requests.length, 0);
  } finally {
    await world.dispose();
  }
});

void test('codex requires its token and refuses a fedramp value that is not a flag', async () => {
  const { world, provider } = await providerWorld('codex');

  try {
    await assert.rejects(
      async () => await provider.create({ providerId: 'cx', values: {} }),
      { message: 'Provider kind codex requires a token value.' },
    );
    await assert.rejects(
      async () =>
        await provider.create({
          providerId: 'cx',
          values: { token: '   ' },
        }),
      { message: 'Provider kind codex requires a token value.' },
    );
    await assert.rejects(
      async () =>
        await provider.create({
          providerId: 'cx',
          values: { fedramp: 'yes' },
          secret: () => Promise.resolve('auth'),
        }),
      { message: 'Provider value fedramp is not a flag: yes' },
    );
  } finally {
    await world.dispose();
  }
});

void test('a built codex provider answers its kind and fields', async () => {
  const { world, provider } = await providerWorld('codex');

  try {
    const built = (await provider.create({
      providerId: 'cx',
      values: { chatGptAccountId: 'acct', fedramp: 'true' },
      secret: () => Promise.resolve('auth'),
    })) as unknown as LlmProvider & { kind: string; configuration: unknown };

    assert.equal(built.kind, 'codex');
    assert.deepEqual(built.configuration, frozenKind().fields);
  } finally {
    await world.dispose();
  }
});
