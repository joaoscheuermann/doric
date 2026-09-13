import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { skillsbenchV1_1 } from './catalog.mjs';
import { startGateway } from './gateway.mjs';
import { prepareAssets, writeManifests } from './prepare.mjs';
import { command } from './process.mjs';

export const runHost = async (mode, outputRoot) => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const checkout = join(root, '.cache/skillsbench');
  const bench = join(root, '.venv/bin/bench');

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      task: { type: 'string', multiple: true },
      config: { type: 'string' },
      'host-address': {
        type: 'string',
        default:
          process.platform === 'darwin' ? 'host.docker.internal' : '172.17.0.1',
      },
      'yes-paid-run': { type: 'boolean', default: false },
      help: { type: 'boolean' },
    },
  });
  const action = positionals[0] ?? 'help';

  if (!/^[a-zA-Z0-9.-]+$/.test(values['host-address'])) {
    throw new Error('Invalid host address.');
  }

  const usage =
    'Local SkillsBench: ' +
    mode +
    '\nCommands: setup, list, prepare, oracle, run.\nRepeat --task ID for a subset; default: jax-computing-basics.\n--config FILE supplies a complete profile. --host-address HOST overrides the container-to-host address.\nModel runs require OPENROUTER_API_KEY and --yes-paid-run.';

  const verifyCheckout = async () => {
    const { output: revision } = await command('git', ['rev-parse', 'HEAD'], {
      cwd: checkout,
      capture: true,
    });

    const { output: status } = await command('git', ['status', '--porcelain'], {
      cwd: checkout,
      capture: true,
    });

    if (revision !== skillsbenchV1_1.revision || status) {
      throw new Error(
        'SkillsBench checkout must be clean and match the pinned revision.',
      );
    }
  };

  const setup = async () => {
    await mkdir(join(root, '.cache'), { recursive: true });

    await command('uv', [
      'venv',
      join(root, '.venv'),
      '--python',
      '3.12',
      '--allow-existing',
    ]);

    await command('uv', [
      'pip',
      'sync',
      '--python',
      join(root, '.venv/bin/python'),
      join(root, 'src/requirements.txt'),
    ]);

    if (!existsSync(checkout)) {
      await command('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        'https://github.com/benchflow-ai/skillsbench.git',
        checkout,
      ]);

      await command('git', ['checkout', skillsbenchV1_1.revision], {
        cwd: checkout,
      });
    }

    await verifyCheckout();

    await command('docker', [
      'info',
      '--format',
      '{{.OSType}} {{.Architecture}}',
    ]);

    console.log(
      'BenchFlow 0.6.6 and SkillsBench ' +
        skillsbenchV1_1.revision +
        ' are ready.',
    );
  };

  const selectedTasks = async () => {
    const tasks = [...new Set(values.task ?? ['jax-computing-basics'])];

    for (const task of tasks) {
      if (
        !/^[a-z0-9][a-z0-9-]*$/.test(task) ||
        !existsSync(join(checkout, 'tasks', task, 'task.md'))
      ) {
        throw new Error('Unknown task: ' + task);
      }
    }

    return tasks;
  };

  const evalArgs = ({ tasks, agent, directory }) => [
    'eval',
    'run',
    '--tasks-dir',
    join(checkout, 'tasks'),
    ...tasks.flatMap((task) => ['--include', task]),
    '--agent',
    agent,
    '--sandbox',
    'docker',
    '--concurrency',
    '1',
    '--build-concurrency',
    '1',
    '--jobs-dir',
    directory,
    '--expected-tasks',
    String(tasks.length),
    '--skill-mode',
    'no-skill',
    '--loop-strategy',
    'single-shot',
    '--run-config-out',
    join(directory, 'run-config.json'),
    '--task-manifest-out',
    join(directory, 'tasks.json'),
    '--health-summary-out',
    join(directory, 'health.json'),
  ];

  const run = async () => {
    await verifyCheckout();

    const tasks = await selectedTasks();
    const directory = join(outputRoot, 'results', randomUUID());

    await mkdir(directory, { recursive: true });

    if (action === 'oracle') {
      console.log('Output: ' + directory);

      const result = await command(
        bench,
        evalArgs({ tasks, agent: 'oracle', directory }),
        {
          allowFailure: true,
          env: { ...process.env, BENCHFLOW_AGENTS_SOURCE: 'off' },
        },
      );

      process.exitCode = result.code;

      return;
    }

    const config = JSON.parse(
      await readFile(values.config ?? join(root, 'src/config.json'), 'utf8'),
    );

    validateConfig(config);

    const prepared = await prepareAssets({ root, checkout, directory, config });

    const manifest = {
      status: 'prepared',
      tasks,
      agents: mode,
      config,
      revision: skillsbenchV1_1.revision,
      catalogHash: prepared.catalogHash,
      skills: prepared.skills,
    };

    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    console.log('Output: ' + directory);

    if (action === 'prepare') {
      return;
    }

    const apiKey = providerKey();
    const token = 'sk-benchflow-' + randomUUID();
    const archive = join(directory, 'agent.tar.gz');

    const models = [
      'planningModel',
      'executionModel',
      'criteriaModel',
      'judgeModel',
      'embeddingModel',
      'rerankerModel',
    ].map((key) => config[key]);

    const gateway = await startGateway({
      archive,
      token,
      models,
      apiKey,
      eventsPath: join(directory, 'events.jsonl'),
      embeddingCacheDirectory: join(root, '.cache/embeddings'),
    });
    const url = 'http://' + values['host-address'] + ':' + gateway.port;
    const results = [];

    try {
      await writeFile(
        join(prepared.assets, 'endpoint.json'),
        JSON.stringify({ baseUrl: url + '/api/v1' }),
      );

      await command('tar', ['-czf', archive, '-C', prepared.assets, '.']);

      manifest.artifactHash = await writeManifests({
        root,
        directory,
        url,
        archive,
      });

      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({ ...manifest, status: 'running' }, null, 2),
      );

      {
        const armDirectory = join(directory, mode);

        await mkdir(armDirectory);

        const start = gateway.usage.length;

        const result = await command(
          bench,
          [
            ...evalArgs({
              tasks,
              agent: 'doric-' + mode,
              directory: armDirectory,
            }),
            '--model',
            'openrouter/' + config.executionModel,
            '--usage-tracking',
            'off',
            '--agent-env',
            'BENCHFLOW_LITELLM_MASTER_KEY=' + token,
          ],
          {
            allowFailure: true,
            env: {
              ...process.env,
              OPENROUTER_API_KEY: token,
              BENCHFLOW_AGENTS_DIR: join(directory, 'agents'),
              BENCHFLOW_AGENTS_SOURCE: 'off',
            },
          },
        );
        const usage = gateway.usage.slice(start);

        results.push({
          agent: mode,
          exitCode: result.code,
          ...usageCounts(usage),
        });

        await writeFile(
          join(armDirectory, 'provider-usage.json'),
          JSON.stringify(usage, null, 2),
        );
      }

      process.exitCode = results.some(({ exitCode }) => exitCode !== 0) ? 1 : 0;
    } finally {
      await gateway.close();

      await writeFile(
        join(directory, 'provider-usage.json'),
        JSON.stringify(gateway.usage, null, 2),
      );

      await writeFile(
        join(directory, 'summary.json'),
        JSON.stringify({ results, ...usageCounts(gateway.usage) }, null, 2),
      );

      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify(
          {
            ...manifest,
            status:
              results.length === 1 && results[0].exitCode === 0
                ? 'finished'
                : 'failed',
          },
          null,
          2,
        ),
      );
    }
  };

  const actions = {
    help: () => console.log(usage),
    setup,
    list: async () => {
      await verifyCheckout();

      console.log(
        (await readdir(join(checkout, 'tasks')))
          .filter((task) =>
            existsSync(join(checkout, 'tasks', task, 'task.md')),
          )
          .sort()
          .join('\n'),
      );
    },
    prepare: run,
    oracle: run,
    run: async () => {
      if (!values['yes-paid-run']) {
        throw new Error('Model runs require --yes-paid-run.');
      }

      await run();
    },
  };

  try {
    const selected = values.help ? 'help' : action;

    if (!Object.hasOwn(actions, selected)) {
      throw new Error('Unknown command.\n' + usage);
    }

    await actions[selected]();
  } catch (error) {
    console.error(error.message);

    process.exitCode = 2;
  }
};

const validateConfig = (config) => {
  for (const key of [
    'retrievalK',
    'topK',
    'maxTurns',
    'maxAttempts',
    'embeddingDimensions',
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) {
      throw new Error('Invalid configuration: ' + key);
    }
  }

  if (config.topK > config.retrievalK) {
    throw new Error('topK must not exceed retrievalK.');
  }
};

const providerKey = () => {
  const key = process.env.OPENROUTER_API_KEY?.trim();

  if (!key) {
    throw new Error('OPENROUTER_API_KEY is required on the host.');
  }

  return key;
};

const usageCounts = (usage) => ({
  providerCalls: usage.filter(({ cache }) => cache !== 'hit').length,
  embeddingCacheHits: usage.filter(({ cache }) => cache === 'hit').length,
});
