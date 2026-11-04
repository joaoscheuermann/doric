// The icons of providers and models over `models/v1.icons`: what the settings
// surfaces ask the host, and the answers the adapter refuses to pass on.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ModelIconAnswers, ModelIconRequest } from 'bundle/contracts';

import type { IconRequest } from '../src/client/domain/model-icons.js';
import { settingsOver, showing } from './support/host.js';

const openrouterSvg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const claudeSvg = '<svg viewBox="0 0 24 24"></svg>';

const requests: readonly IconRequest[] = [
  {
    providerId: 'openrouter',
    kind: 'openrouter',
    configuration: {
      endpoint: 'https://openrouter.ai/api/v1',
      token: '00000000-0000-4000-8000-000000000001',
    },
    models: ['anthropic/claude-sonnet-4', 'acme/coder-7b'],
  },
  {
    providerId: 'lmstudio',
    kind: 'openai',
    configuration: { endpoint: 'http://localhost:1234/v1' },
    models: [],
  },
];

/** An answer that matches `requests`, which each refusal case breaks once. */
const answers: ModelIconAnswers = {
  svgs: { openrouter: openrouterSvg, claude: claudeSvg },
  answers: [
    { provider: 'openrouter', models: ['claude', 'openrouter'] },
    { models: [] },
  ],
};

describe('model icons', () => {
  test('icons reach models/v1 in one call without the provider id, and the answer comes back with its svgs', async () => {
    const asked: { readonly requests: readonly ModelIconRequest[] }[] = [];

    await settingsOver(
      {
        icons: (input) => {
          asked.push(input);
          return answers;
        },
      },
      async (api) => {
        assert.deepEqual(await api.providers.icons(requests), answers);
      },
    );

    assert.deepEqual(asked, [
      {
        requests: requests.map(({ kind, configuration, models }) => ({
          kind,
          configuration,
          models,
        })),
      },
    ]);
  });

  test('no requests make no host call', async () => {
    // The fake host has no `icons` answer: a call would fail.
    await settingsOver({}, async (api) => {
      assert.deepEqual(await api.providers.icons([]), {
        svgs: {},
        answers: [],
      });
    });
  });

  test('an SVG not starting with `<svg`, a name missing from svgs, or a length mismatch is an invalid response', async () => {
    const refused: readonly [string, ModelIconAnswers][] = [
      [
        'an SVG not starting with <svg',
        { ...answers, svgs: { ...answers.svgs, claude: '<path d="M0 0"/>' } },
      ],
      [
        'a name missing from svgs',
        { ...answers, svgs: { openrouter: openrouterSvg } },
      ],
      [
        'fewer answers than requests',
        { ...answers, answers: answers.answers.slice(0, 1) },
      ],
      [
        "an answer's models of another length than its request's",
        {
          ...answers,
          answers: [
            { provider: 'openrouter', models: ['claude'] },
            { models: [] },
          ],
        },
      ],
    ];

    for (const [label, answer] of refused) {
      await settingsOver({ icons: () => answer }, async (api) => {
        await assert.rejects(
          api.providers.icons(requests),
          showing('Doric returned an invalid response.'),
          label,
        );
      });
    }
  });
});
