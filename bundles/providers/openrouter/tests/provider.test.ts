import assert from 'node:assert/strict';
import test from 'node:test';

import type { LlmProvider } from 'llms';

import { frozenKind, providerWorld } from './support/world.js';

void test('the openrouter record answers the frozen llms kind, is advertised and reports catalog capacity', async () => {
  const { world, provider } = await providerWorld('openrouter');

  try {
    assert.deepEqual(await provider.kind(), frozenKind());
    assert.equal(await provider.advertised(), true);
    assert.equal(await provider.catalogCapacity(), true);
  } finally {
    await world.dispose();
  }
});

void test('openrouter requires its token and refuses a repair count that is not a number', async () => {
  const { world, provider } = await providerWorld('openrouter');

  try {
    await assert.rejects(
      async () => await provider.create({ providerId: 'or', values: {} }),
      { message: 'Provider kind openrouter requires a token value.' },
    );
    await assert.rejects(
      async () =>
        await provider.create({
          providerId: 'or',
          values: { maxStructuredOutputRepairs: 'many' },
          secret: () => Promise.resolve('sk'),
        }),
      {
        message:
          'Provider value maxStructuredOutputRepairs is not a number: many',
      },
    );
  } finally {
    await world.dispose();
  }
});

void test('a built openrouter provider answers its kind and fields', async () => {
  const { world, provider } = await providerWorld('openrouter');

  try {
    const built = (await provider.create({
      providerId: 'or',
      values: { maxStructuredOutputRepairs: '3' },
      secret: () => Promise.resolve('sk'),
    })) as unknown as LlmProvider & { kind: string; configuration: unknown };

    assert.equal(built.kind, 'openrouter');
    assert.deepEqual(built.configuration, frozenKind().fields);
  } finally {
    await world.dispose();
  }
});
