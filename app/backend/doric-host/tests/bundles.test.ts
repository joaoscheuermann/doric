import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { Platform } from 'bundle/platform';
import pino from 'pino';

import {
  BundleRecoveryError,
  bundlePaths,
  type HostPlatform,
  hostComposition,
  hostReady,
  startHostPlatform,
} from '../src/lib/bundles/boot.js';
import { firstStreamItem } from './helpers/api.js';
import { freshDatabase } from './helpers/host.js';
import { credentialKey } from './helpers/platform.js';
import {
  childProcesses,
  clientOnlyBundles,
  hostPartBundles,
  spawnedBundles,
} from './helpers/processes.js';

// Build doric first: these tests boot the bundles the host stages in
// dist/bundles (`stage --dev`) with the composition it ships, through
// `startHostPlatform`, as `src/index.ts` does. Each host part runs in its own
// process, a direct child of this test process. A boot that reaches the
// storage identity needs PostgreSQL (`DORIC_TEST_DATABASE_URL`); a boot that
// ends with a structural fault reads no database, so those cases run without.

/** The built bundles the host stages, and the composition it ships. */
const bundlesPath = 'app/backend/doric-host/dist/bundles';
const compositionPath = 'app/backend/doric-host/composition.json';

/** The options of a case that boots over a database. */
const needsDatabase = {
  skip:
    process.env.DORIC_TEST_DATABASE_URL === undefined
      ? 'Requires DORIC_TEST_DATABASE_URL'
      : false,
  timeout: 180_000,
} as const;

/** The case boots without a database: the boot ends before the identity read. */
const noDatabase = { timeout: 180_000 } as const;

/** The base environment of the instances: this process's, without `DORIC_*`. */
const baseEnvironment = (
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('DORIC_')),
  ),
  ...extra,
});

/** A pino logger whose records the case reads back. */
const recorded = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: 'debug' },
    {
      write: (line: string) =>
        lines.push(JSON.parse(line) as Record<string, unknown>),
    },
  );

  return { lines, logger };
};

/** A startup sink that keeps the stages and the lines it is told. */
const startupRecord = () => {
  const stages: string[] = [];
  const messages: string[] = [];

  return {
    stages,
    messages,
    sink: {
      stage: (name: string) => {
        stages.push(name);
      },
      log: ({ message }: { readonly message: string }) => {
        messages.push(message);
      },
    },
  };
};

/**
 * Boots a bundles root as the host does: the composition as `hostComposition`
 * reads it (`variables` choose the alternatives, or name an operator file),
 * the public listener on a free port of 127.0.0.1.
 */
const boot = async (
  options: {
    readonly bundles?: string;
    readonly composition?: string;
    readonly variables?: Readonly<Record<string, string>>;
    readonly env?: NodeJS.ProcessEnv;
    readonly logger?: pino.Logger;
    readonly exits?: number[];
  } = {},
): Promise<HostPlatform> => {
  const path = options.composition ?? compositionPath;
  const { composition, required } = await hostComposition(
    options.variables ?? {},
    path,
  );

  return startHostPlatform({
    bundlesPath: options.bundles ?? bundlesPath,
    compositionPath: path,
    composition,
    required,
    publicAddress: '127.0.0.1:0',
    startup: startupRecord().sink,
    logger: options.logger ?? pino({ enabled: false }),
    exit: (code) => {
      options.exits?.push(code);
    },
    env: options.env ?? baseEnvironment(),
  });
};

/** Boots over a fresh database and shuts the host down after `run`. */
const withHost = async (
  run: (host: HostPlatform) => Promise<void>,
  options: Omit<Parameters<typeof boot>[0] & object, 'env'> = {},
): Promise<void> => {
  const connectionString = process.env.DORIC_TEST_DATABASE_URL;
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  const storage = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'storage-'),
  );

  try {
    const host = await boot({
      ...options,
      env: baseEnvironment({
        DORIC_DATABASE_URL: database.url,
        DORIC_CREDENTIAL_KEY: credentialKey,
        DORIC_STORAGE_PATH: storage,
      }),
    });

    try {
      await run(host);
    } finally {
      await host.platform.shutdown();
    }
  } finally {
    await database.close();
    await rm(storage, { recursive: true, force: true });
  }
};

/**
 * A bundles root holding copies of the staged bundles, for altered layouts. It
 * lives inside the workspace, as the staged root does, so the copies resolve
 * their package imports the same way.
 */
const stagedCopy = async (): Promise<string> => {
  const root = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'bundles-'),
  );

  await cp(bundlesPath, root, { recursive: true });

  return root;
};

/** The shipped composition with `change` applied, written as an operator file. */
const operatorComposition = async (
  directory: string,
  change: (composition: {
    enabled: string[];
    required: { contracts: string[]; bundles: string[] };
  }) => unknown,
): Promise<string> => {
  const shipped = JSON.parse(await readFile(compositionPath, 'utf8')) as {
    enabled: string[];
    required: { contracts: string[]; bundles: string[] };
  };
  const path = join(directory, 'composition.json');

  await writeFile(path, JSON.stringify(change(shipped)));

  return path;
};

/** A structural fault: rejects with `BundleRecoveryError`, logged, nothing left running. */
const assertRecovery = async (
  change: Parameters<typeof operatorComposition>[1],
  reasonIncludes: readonly string[],
): Promise<void> => {
  const directory = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'composition-'),
  );
  const { lines, logger } = recorded();

  try {
    const path = await operatorComposition(directory, change);

    await assert.rejects(
      boot({
        composition: path,
        variables: { DORIC_COMPOSITION: path },
        logger,
      }),
      (error: unknown) =>
        error instanceof BundleRecoveryError &&
        error.message.includes('structural providers unavailable') &&
        reasonIncludes.every((id) => error.message.includes(id)),
    );
    assert.ok(
      lines.some(
        ({ msg, reason }) =>
          msg === 'Bundle recovery mode' &&
          typeof reason === 'string' &&
          reasonIncludes.every((id) => reason.includes(id)),
      ),
      JSON.stringify(lines.filter(({ level }) => Number(level) >= 40)),
    );
    // The platform was shut down before the rejection: no bundle process is
    // left running.
    assert.deepEqual(await childProcesses(process.pid), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Today's tools, in their model-visible order (the default settings). */
const todaysTools = [
  'cwd',
  'edit',
  'find',
  'grep',
  'terminal',
  'tree',
  'web',
  'write',
  'view-image',
  'git',
  'thread-spawn',
  'thread-list',
  'thread-get',
  'thread-events',
  'thread-send',
  'thread-interrupt',
  'thread-terminate',
  'thread-restart',
  'comment_reply',
];

/** The tool names `tools/v1.List` answers the caller `doric`. */
const listedTools = async (host: HostPlatform): Promise<string[]> =>
  (await host.platform.client(ToolsService).list({})).tools.map(
    ({ tool }) => tool?.name ?? '',
  );

void test('the bundles root and composition come from the environment or the host defaults', () => {
  assert.deepEqual(
    bundlePaths({}, '/opt/doric/app/backend/doric-host/dist/src'),
    {
      bundlesPath: '/opt/doric/app/backend/doric-host/dist/bundles',
      compositionPath: '/opt/doric/app/backend/doric-host/composition.json',
    },
  );
  assert.deepEqual(
    bundlePaths(
      { DORIC_BUNDLES_PATH: '/srv/bundles', DORIC_COMPOSITION: '/srv/c.json' },
      '/opt/doric/app/backend/doric-host/dist/src',
    ),
    { bundlesPath: '/srv/bundles', compositionPath: '/srv/c.json' },
  );
});

void test(
  'a contract the composition requires that no provider serves refuses the boot with Bundle recovery mode',
  noDatabase,
  async () => {
    await assertRecovery(
      (composition) => ({
        ...composition,
        required: {
          ...composition.required,
          contracts: [...composition.required.contracts, 'nothing/v1'],
        },
      }),
      ['nothing/v1'],
    );
  },
);

void test(
  'a composition without the runtime has no structural provider and the boot refuses it',
  noDatabase,
  async () => {
    await assertRecovery(
      (composition) => ({
        ...composition,
        enabled: composition.enabled.filter((id) => id !== 'runtime'),
      }),
      // The transport requires the runtime, so it cannot serve either.
      ['runtime/v2', 'transport'],
    );
  },
);

void test('hostReady logs a failing onHostReadyHook at warn and never throws', async () => {
  const { lines, logger } = recorded();
  const unavailable = () =>
    Promise.reject(
      new ContractError('unavailable', 'No hooks/v1 provider is active.'),
    );
  // The `doric` caller of a host whose `hooks/v1` provider is gone: every
  // call answers `unavailable`.
  const platform = {
    client: () => new Proxy({}, { get: () => unavailable }),
  } as unknown as Platform;

  await hostReady(platform, logger);

  const warnings = lines.filter(({ level }) => level === 40);
  assert.equal(warnings.length, 1, JSON.stringify(lines));
  assert.ok(JSON.stringify(warnings[0]).includes('unavailable'));
});

void test(
  'every enabled bundle is active, one process per host part, and the client-only bundles are never spawned',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const states = Object.fromEntries(
        host.diagnostics.snapshot().bundles.map(({ id, state }) => [id, state]),
      );

      for (const id of [...hostPartBundles, ...clientOnlyBundles])
        assert.equal(states[id], 'active', id);
      // `firecracker` is staged beside `docker` but not enabled (D10-9).
      assert.notEqual(states.firecracker, 'active');
      assert.deepEqual(host.resolved.order.slice(0, 2), ['postgres', 'core']);

      const spawned = await spawnedBundles(
        bundlesPath,
        await childProcesses(process.pid),
      );
      assert.deepEqual([...spawned].sort(), hostPartBundles);
    });
  },
);

void test(
  "tools/v1.List as doric names today's tools in their order",
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      assert.deepEqual(await listedTools(host), todaysTools);
    });
  },
);

void test(
  'api.status/v1 answers on the public listener',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      assert.ok(host.platform.publicPort);
      const first = await firstStreamItem(
        `http://127.0.0.1:${String(host.platform.publicPort)}`,
        'doric.api.status.v1.StatusService/Watch',
      );

      assert.deepEqual(first, { ready: {} });
    });
  },
);

void test(
  'a quarantined optional bundle leaves the host up and the others serving',
  needsDatabase,
  async () => {
    const root = await stagedCopy();
    const exits: number[] = [];

    try {
      // The staged command cannot be read, so the supervisor quarantines
      // `web` (`invalid_bundle`) instead of spawning it.
      await writeFile(join(root, 'web', 'host', 'command.json'), 'not json');

      await withHost(
        async (host) => {
          const web = host.diagnostics
            .snapshot()
            .bundles.find(({ id }) => id === 'web');
          assert.equal(web?.state, 'quarantined');

          const tools = await listedTools(host);
          assert.ok(!tools.includes('web'), tools.join(', '));
          assert.ok(tools.includes('thread-spawn'), tools.join(', '));

          // No structural provider was lost: the host listens and stays up.
          assert.ok(host.platform.publicPort);
          assert.deepEqual(
            await firstStreamItem(
              `http://127.0.0.1:${String(host.platform.publicPort)}`,
              'doric.api.status.v1.StatusService/Watch',
            ),
            { ready: {} },
          );
          assert.deepEqual(exits, []);
        },
        { bundles: root, exits },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
