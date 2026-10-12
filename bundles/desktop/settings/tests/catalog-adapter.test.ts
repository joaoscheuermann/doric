// Provider kinds, a draft's model catalog and the tool catalog over
// `models/v1` and `tools/v1`, with the `/providers` and `/tools` answers.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ModelKindDescriptor } from 'bundle/contracts';

import { settingsOver, showing } from './support/host.js';

const openrouter: ModelKindDescriptor = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Hosted models.',
  fields: [
    { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
  ],
  lists: ['models', 'reasonings'],
};

const draft = {
  kind: 'openrouter',
  configuration: {
    endpoint: 'https://openrouter.ai/api/v1',
    token: '00000000-0000-4000-8000-000000000001',
  },
};

describe('a draft provider catalog', () => {
  test('lists the models the endpoint described', async () => {
    await settingsOver(
      {
        kind: (id) => (id === 'openrouter' ? openrouter : undefined),
        catalog: () => ({
          status: 'read',
          models: [
            {
              id: 'deepseek/v4',
              reasonings: ['low', 'high'],
              parameters: ['reasoning'],
              mandatory: false,
            },
          ],
        }),
      },
      async (api) => {
        assert.deepEqual(await api.providers.models(draft), [
          {
            id: 'deepseek/v4',
            reasonings: ['low', 'high'],
            parameters: ['reasoning'],
          },
        ]);
      },
    );
  });

  test('values the kind does not declare are refused before any read', async () => {
    let read = false;

    await settingsOver(
      {
        kind: (id) => (id === 'openrouter' ? openrouter : undefined),
        catalog: () => {
          read = true;
          return { status: 'absent' };
        },
      },
      async (api) => {
        for (const values of [
          { ...draft, kind: 'unknown' },
          {
            ...draft,
            configuration: {
              endpoint: 'ftp://x',
              token: draft.configuration.token,
            },
          },
          {
            ...draft,
            configuration: { endpoint: draft.configuration.endpoint },
          },
          { ...draft, configuration: { ...draft.configuration, extra: 'x' } },
        ]) {
          await assert.rejects(
            api.providers.models(values),
            showing('The provider values are invalid.'),
          );
        }
      },
    );

    assert.equal(read, false);
  });

  test('a catalog the endpoint did not answer is reported as unreadable', async () => {
    for (const status of ['absent', 'failed'] as const) {
      await settingsOver(
        { kind: () => openrouter, catalog: () => ({ status }) },
        async (api) => {
          await assert.rejects(
            api.providers.models(draft),
            showing('The provider model catalog could not be read.'),
          );
        },
      );
    }
  });
});

describe('the host catalogs', () => {
  test('provider kinds arrive in the host order', async () => {
    await settingsOver(
      {
        kinds: () => [
          openrouter,
          { ...openrouter, id: 'openai', label: 'OpenAI' },
        ],
      },
      async (api) => {
        assert.deepEqual(
          (await api.providers.kinds()).map((kind) => kind.id),
          ['openrouter', 'openai'],
        );
      },
    );
  });

  test('the tool catalog carries each tool and the fields it declares', async () => {
    await settingsOver(
      {
        tools: () => [
          {
            name: 'web_search',
            description: 'Searches the web.',
            settings: [
              {
                key: 'apiKey',
                label: 'API key',
                kind: 'secret',
                required: true,
              },
            ],
          },
          { name: 'shell', settings: [] },
        ],
      },
      async (api) => {
        assert.deepEqual(await api.tools.catalog(), [
          {
            name: 'web_search',
            description: 'Searches the web.',
            settings: [
              {
                key: 'apiKey',
                label: 'API key',
                kind: 'secret',
                required: true,
              },
            ],
          },
          { name: 'shell', settings: [] },
        ]);
      },
    );
  });
});
