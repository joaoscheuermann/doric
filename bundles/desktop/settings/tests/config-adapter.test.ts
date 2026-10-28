// The settings window's configuration reads and saves over `host-config/v1`
// keep what reached the host and what the window showed when they went
// through the IPC guard and the `/config` route.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { DoricConfiguration } from 'runtime/contracts';

import type { Configuration } from '../src/client/domain/config.js';
import { settingsOver, showing } from './support/host.js';

const token = '00000000-0000-4000-8000-000000000001';

const configuration: Configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { endpoint: 'https://openrouter.ai/api/v1', token },
      models: [
        { name: 'deepseek/v4', reasonings: ['low'], defaultEffort: 'low' },
      ],
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/v4',
      effort: 'low',
    },
  },
  execution: { maxTurns: 32 },
};

const stored = (value: Configuration, revision = 4): DoricConfiguration => ({
  configuration: value,
  revision,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('saving the configuration', () => {
  test('never sends the Tools values nor the tool result limit to the host', async () => {
    let sent: unknown;

    await settingsOver(
      {
        replace: (input) => {
          sent = input;
          return { status: 'replaced', config: stored(configuration, 5) };
        },
      },
      async (api) => {
        await api.config.update({
          ...configuration,
          execution: { maxTurns: 32, maxToolResultChars: 4000 },
          tools: { web: { apiKey: token } },
        });
      },
    );

    assert.deepEqual(sent, configuration);
  });

  test('never sends the context-compaction policy to the host', async () => {
    let sent: unknown;

    await settingsOver(
      {
        replace: (input) => {
          sent = input;
          return { status: 'replaced', config: stored(configuration, 5) };
        },
      },
      async (api) => {
        await api.config.update({
          ...configuration,
          execution: {
            maxTurns: 32,
            contextCompaction: {
              enabled: true,
              pressurePercent: 80,
              tailMinMessages: 6,
              summaryMaxChars: 6000,
              charBudget: 200000,
            },
          },
        });
      },
    );

    assert.deepEqual(sent, configuration);
  });

  test('sends an empty or null credential choice as none, and a named one as itself', async () => {
    const sent: unknown[] = [];

    await settingsOver(
      {
        replace: (input) => {
          sent.push(input);
          return { status: 'replaced', config: stored(configuration) };
        },
      },
      async (api) => {
        await api.config.update({
          ...configuration,
          gitCredentialId: '',
          githubCredentialId: null as unknown as string,
        });
        await api.config.update({ ...configuration, gitCredentialId: token });
      },
    );

    assert.deepEqual(sent, [
      configuration,
      { ...configuration, gitCredentialId: token },
    ]);
  });

  test('answers with the configuration the host stored', async () => {
    await settingsOver(
      {
        replace: () => ({
          status: 'replaced',
          config: stored(configuration, 9),
        }),
      },
      async (api) => {
        const saved = await api.config.update(configuration);

        assert.equal(saved.revision, 9);
        assert.deepEqual(saved.configuration, configuration);
      },
    );
  });

  test('refuses a shape the host could never accept before asking it', async () => {
    let asked = false;

    await settingsOver(
      {
        replace: () => {
          asked = true;
          return { status: 'rejected' };
        },
      },
      async (api) => {
        for (const broken of [
          { ...configuration, execution: { maxTurns: 0 } },
          { ...configuration, execution: { maxTurns: 1.5 } },
          {
            ...configuration,
            models: { execution: { providerId: '', model: 'm' } },
          },
          {
            ...configuration,
            providers: [
              { id: 'p', kind: 'openai', configuration: { key: '' } },
            ],
          },
        ]) {
          await assert.rejects(
            api.config.update(broken as Configuration),
            showing('The configuration is invalid.'),
          );
        }
      },
    );

    assert.equal(asked, false);
  });

  test('shows the host message for a configuration it refused', async () => {
    await settingsOver(
      {
        replace: () => ({
          status: 'invalid',
          message: 'The execution provider is not configured.',
        }),
      },
      async (api) => {
        await assert.rejects(
          api.config.update(configuration),
          showing('The execution provider is not configured.'),
        );
      },
    );
  });

  test('shows the activation failure when the host could not apply it', async () => {
    for (const replace of [
      () => ({ status: 'rejected' as const }),
      () => {
        throw new ContractError('internal', 'boom');
      },
    ]) {
      await settingsOver({ replace }, async (api) => {
        await assert.rejects(
          api.config.update(configuration),
          showing('The Doric configuration could not be activated.'),
        );
      });
    }
  });

  test('says the backend is unavailable when the host cannot be reached', async () => {
    await settingsOver(
      {
        replace: () => {
          throw new ContractError(
            'unavailable',
            'Doric backend is unavailable.',
          );
        },
        current: () => {
          throw new ContractError(
            'disconnected',
            'The host bridge disconnected.',
          );
        },
      },
      async (api) => {
        await assert.rejects(
          api.config.update(configuration),
          showing('Doric backend is unavailable.'),
        );
        await assert.rejects(
          api.config.get(),
          showing('Doric backend is unavailable.'),
        );
      },
    );
  });
});

describe('the profile', () => {
  test('reads the stored profile and sends it back with an edit', async () => {
    const profiled: Configuration = {
      ...configuration,
      profile: { name: 'Ana', timezone: 'America/Sao_Paulo' },
    };
    let sent: unknown;

    await settingsOver(
      {
        current: () => stored(profiled, 3),
        replace: (input) => {
          sent = input;
          return { status: 'replaced', config: stored(profiled, 4) };
        },
      },
      async (api) => {
        const read = await api.config.get();
        assert.deepEqual(read.configuration.profile, profiled.profile);

        await api.config.update({
          ...read.configuration,
          execution: { maxTurns: 12 },
        });
      },
    );

    const body = sent as Configuration;
    assert.deepEqual(body.profile, {
      name: 'Ana',
      timezone: 'America/Sao_Paulo',
    });
    assert.deepEqual(body.execution, { maxTurns: 12 });
  });
});

describe('reading the configuration', () => {
  test('reads the stored configuration, its revision and update time', async () => {
    const value = {
      ...configuration,
      execution: { maxTurns: 32, maxToolResultChars: 4000 },
      tools: { web: { apiKey: token } },
      githubCredentialId: token,
    };

    await settingsOver({ current: () => stored(value, 3) }, async (api) => {
      assert.deepEqual(await api.config.get(), stored(value, 3));
    });
  });

  test('carries the context-compaction policy the host stores through', async () => {
    const value = {
      ...configuration,
      execution: {
        maxTurns: 32,
        contextCompaction: {
          enabled: true,
          pressurePercent: 80,
          tailMinMessages: 6,
          summaryMaxChars: 6000,
          charBudget: 200000,
        },
      },
    };

    await settingsOver({ current: () => stored(value, 3) }, async (api) => {
      assert.deepEqual(await api.config.get(), stored(value, 3));
    });
  });

  test('refuses an answer naming a reasoning effort the window cannot send', async () => {
    await settingsOver(
      {
        current: () =>
          stored({
            ...configuration,
            models: {
              execution: {
                providerId: 'openrouter',
                model: 'm',
                effort: 'turbo',
              },
            },
          } as unknown as Configuration),
      },
      async (api) => {
        await assert.rejects(
          api.config.get(),
          showing('Doric returned an invalid response.'),
        );
      },
    );
  });

  test('shows the final error text for an unexpected host failure', async () => {
    await settingsOver(
      {
        current: () => {
          throw new ContractError('internal', 'database exploded');
        },
      },
      async (api) => {
        await assert.rejects(
          api.config.get(),
          showing('The request could not be completed.'),
        );
      },
    );
  });
});
