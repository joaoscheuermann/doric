import assert from 'node:assert/strict';
import test from 'node:test';

import { type LlmProvider, providerKind } from 'llms';

import {
  frozenKind,
  providerWorld,
  recordingTransport,
} from './support/world.js';

void test('the claude record answers the frozen llms kind, is advertised and reports catalog capacity', async () => {
  const { world, provider } = await providerWorld('claude');

  try {
    // The fields and text are frozen; the lists are whatever the llms kind
    // keeps, so a list llms adds reaches the settings tables.
    assert.deepEqual(await provider.kind(), {
      ...frozenKind(),
      lists: providerKind('claude')?.lists,
    });
    assert.equal(await provider.advertised(), true);
    assert.equal(await provider.catalogCapacity(), true);
  } finally {
    await world.dispose();
  }
});

void test('without a login there is no catalog to read, and nothing is requested', async () => {
  const { requests, transport } = recordingTransport();
  const { world, provider } = await providerWorld('claude', { transport });

  try {
    assert.deepEqual(await provider.catalog({ configuration: {} }), {
      status: 'absent',
    });
    assert.deepEqual(
      await provider.catalog({ configuration: {}, secret: '  ' }),
      { status: 'absent' },
    );
    assert.equal(requests.length, 0);
  } finally {
    await world.dispose();
  }
});

void test('the catalog is every model the login may call, with the efforts Anthropic lists for each', async () => {
  const effort = (...levels: string[]) => ({
    supported: levels.length > 0,
    ...Object.fromEntries(
      ['low', 'medium', 'high', 'xhigh', 'max'].map((level) => [
        level,
        { supported: levels.includes(level) },
      ]),
    ),
  });
  const { requests, transport } = recordingTransport({
    data: [
      {
        id: 'claude-opus-5-5',
        display_name: 'Claude Opus 5.5',
        max_input_tokens: 1_000_000,
        capabilities: {
          effort: effort('low', 'medium', 'high', 'xhigh', 'max'),
        },
      },
      {
        id: 'claude-sonnet-4-6',
        display_name: 'Claude Sonnet 4.6',
        capabilities: { effort: effort('low', 'medium', 'high', 'max') },
      },
      {
        id: 'claude-haiku-4-5-20251001',
        display_name: 'Claude Haiku 4.5',
        capabilities: { effort: effort() },
      },
      // A listing without capabilities falls back to what the id says.
      { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    ],
    has_more: false,
  });
  const { world, provider } = await providerWorld('claude', { transport });

  try {
    const read = await provider.catalog({
      configuration: {},
      secret: 'Bearer claude-login',
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0]?.url ?? '', /\/v1\/models\?/);
    assert.equal(requests[0]?.headers?.authorization, 'Bearer claude-login');
    assert.deepEqual(read, {
      status: 'read',
      models: [
        {
          id: 'claude-opus-5-5',
          name: 'Claude Opus 5.5',
          reasonings: ['low', 'medium', 'high', 'xhigh', 'max'],
          parameters: [],
          defaultEffort: 'medium',
          mandatory: false,
        },
        {
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          reasonings: ['low', 'medium', 'high', 'max'],
          parameters: [],
          defaultEffort: 'high',
          mandatory: false,
        },
        {
          id: 'claude-haiku-4-5-20251001',
          name: 'Claude Haiku 4.5',
          reasonings: [],
          parameters: [],
          mandatory: false,
        },
        {
          id: 'claude-sonnet-5-5',
          name: 'Claude Sonnet 5.5',
          reasonings: ['low', 'medium', 'high', 'xhigh', 'max'],
          parameters: [],
          defaultEffort: 'high',
          mandatory: false,
        },
      ],
    });
  } finally {
    await world.dispose();
  }
});

void test('a catalog the login is refused is a failed read that names nothing of it', async () => {
  const transport = {
    request: () =>
      Promise.resolve({
        status: 401,
        headers: {},
        body: JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid token' },
        }),
      }),
    stream: () => {
      throw new Error('No stream in these tests.');
    },
  };
  const { world, provider } = await providerWorld('claude', { transport });

  try {
    assert.deepEqual(
      await provider.catalog({ configuration: {}, secret: 'Bearer expired' }),
      { status: 'failed' },
    );
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
