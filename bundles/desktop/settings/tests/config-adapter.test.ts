// The settings window's configuration reads and saves over `host-config/v1`
// keep what reached the host and what the window showed when they went
// through the IPC guard and the `/config` route.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { DoricConfiguration } from 'runtime/contracts';

import type { Configuration } from '../src/client/domain/config.js';
import { settingsError, settingsOver, showing } from './support/host.js';

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

describe('the auto-archive policy', () => {
  const archiving: Configuration = {
    ...configuration,
    threads: { autoArchive: { agentThreads: false, mainThreadsAfter: '30d' } },
  };

  test('a read keeps threads.autoArchive as the host answered it', async () => {
    await settingsOver({ current: () => stored(archiving, 3) }, async (api) => {
      assert.deepEqual(await api.config.get(), stored(archiving, 3));
    });
  });

  test('a save sends threads.autoArchive, and a save without threads sends none', async () => {
    const sent: unknown[] = [];

    await settingsOver(
      {
        replace: (input) => {
          sent.push(input);
          return { status: 'replaced', config: stored(archiving, 5) };
        },
      },
      async (api) => {
        await api.config.update(archiving);
        await api.config.update(configuration);
      },
    );

    assert.deepEqual(sent, [archiving, configuration]);
    assert.equal('threads' in (sent[1] as object), false);
  });

  test('a save of a stored threads read back keeps it beside an edit elsewhere', async () => {
    let sent: unknown;

    await settingsOver(
      {
        current: () => stored(archiving, 3),
        replace: (input) => {
          sent = input;
          return { status: 'replaced', config: stored(archiving, 4) };
        },
      },
      async (api) => {
        const read = await api.config.get();
        await api.config.update({
          ...read.configuration,
          execution: { maxTurns: 12 },
        });
      },
    );

    assert.deepEqual((sent as Configuration).threads, archiving.threads);
  });

  test('keeps only the keys it knows, on a read and on a save', async () => {
    const extended = {
      ...configuration,
      threads: {
        autoArchive: {
          agentThreads: true,
          mainThreadsAfter: '1d',
          pinnedToo: true,
        },
        legacy: 'x',
      },
    } as unknown as Configuration;
    const known = {
      autoArchive: { agentThreads: true, mainThreadsAfter: '1d' },
    };
    let sent: unknown;

    await settingsOver(
      {
        current: () => stored(extended, 3),
        replace: (input) => {
          sent = input;
          return { status: 'replaced', config: stored(configuration, 4) };
        },
      },
      async (api) => {
        const read = await api.config.get();
        assert.deepEqual(read.configuration.threads, known);

        await api.config.update(extended);
      },
    );

    assert.deepEqual((sent as Configuration).threads, known);
  });

  test('refuses a threads value the host could never accept before asking it', async () => {
    let asked = false;

    await settingsOver(
      {
        replace: () => {
          asked = true;
          return { status: 'rejected' };
        },
      },
      async (api) => {
        for (const threads of [
          { autoArchive: { mainThreadsAfter: '14d' } },
          { autoArchive: { agentThreads: 'yes' } },
          { autoArchive: 'on' },
          'on',
        ]) {
          await assert.rejects(
            api.config.update({
              ...configuration,
              threads,
            } as unknown as Configuration),
            showing('The configuration is invalid.'),
          );
        }
      },
    );

    assert.equal(asked, false);
  });

  test('refuses a host answer naming an unknown mainThreadsAfter as an invalid response', async () => {
    await settingsOver(
      {
        current: () =>
          stored({
            ...configuration,
            threads: { autoArchive: { mainThreadsAfter: '14d' } },
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

// T-22 (error-messages.md §6.4): every rejection keeps the message the window
// showed and gains the code of its outcome; the contract error the host
// answered becomes its cause, unless that error is `internal`.
describe('T-22 configuration rejections keep their code and cause', () => {
  test('a contract error the host answered keeps its code and is the cause', async () => {
    for (const [code, message] of [
      ['disconnected', 'Doric backend is unavailable.'],
      ['unavailable', 'Doric backend is unavailable.'],
      ['invalid_output', 'Doric returned an invalid response.'],
      ['limit_exceeded', 'The request could not be completed.'],
    ] as const) {
      const contract = new ContractError(code, 'what the bridge said');
      await settingsOver(
        {
          current: () => {
            throw contract;
          },
        },
        async (api) => {
          await assert.rejects(
            api.config.get(),
            settingsError({ code, message, cause: contract }),
          );
        },
      );
    }
  });

  test('a host out of reach on save keeps its code and is the cause', async () => {
    const contract = new ContractError('unavailable', 'what the bridge said');
    await settingsOver(
      {
        replace: () => {
          throw contract;
        },
      },
      async (api) => {
        await assert.rejects(
          api.config.update(configuration),
          settingsError({
            code: 'unavailable',
            message: 'Doric backend is unavailable.',
            cause: contract,
          }),
        );
      },
    );
  });

  test('an internal contract error or a foreign throw is internal with no cause', async () => {
    for (const thrown of [
      new ContractError('internal', 'database exploded'),
      new Error('the bridge is gone'),
    ]) {
      await settingsOver(
        {
          current: () => {
            throw thrown;
          },
        },
        async (api) => {
          await assert.rejects(
            api.config.get(),
            settingsError({
              code: 'internal',
              message: 'The request could not be completed.',
              cause: undefined,
            }),
          );
        },
      );
    }
  });

  test('a shape refused before the host is invalid_input with no cause', async () => {
    await settingsOver({}, async (api) => {
      await assert.rejects(
        api.config.update({
          ...configuration,
          execution: { maxTurns: 0 },
        }),
        settingsError({
          code: 'invalid_input',
          message: 'The configuration is invalid.',
          cause: undefined,
        }),
      );
    });
  });

  test('an answer the adapter cannot read is invalid_output with no cause', async () => {
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
          settingsError({
            code: 'invalid_output',
            message: 'Doric returned an invalid response.',
            cause: undefined,
          }),
        );
      },
    );
  });

  test('a replace answered invalid is invalid_input; any other refused replace is internal', async () => {
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
          settingsError({
            code: 'invalid_input',
            message: 'The execution provider is not configured.',
            cause: undefined,
          }),
        );
      },
    );
    for (const replace of [
      () => ({ status: 'rejected' as const }),
      () => {
        throw new ContractError('internal', 'boom');
      },
    ]) {
      await settingsOver({ replace }, async (api) => {
        await assert.rejects(
          api.config.update(configuration),
          settingsError({
            code: 'internal',
            message: 'The Doric configuration could not be activated.',
            cause: undefined,
          }),
        );
      });
    }
  });
});
