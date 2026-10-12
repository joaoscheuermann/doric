import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { type Composition, readComposition } from 'bundle';
import { SkillsV1, ToolsV1 } from 'bundle/contracts';
import express from 'express';
import pino from 'pino';
import { Server as SocketServer } from 'socket.io';

import {
  assertStructural,
  BundleRecoveryError,
  type Bundles,
  bundlePaths,
  hostComposition,
  startBundles,
  watchStructural,
} from '../src/lib/bundles/boot.js';
import { createHostConfig } from '../src/lib/bundles/configuration.js';
import { createHostTransport } from '../src/lib/bundles/transport.js';

// Build doric first: these tests boot the bundles the host stages in
// dist/bundles with the composition it ships, through the real loader, and
// with the kernel's embedded `host-config` and `transport`, as the host does.
// The installed bundles run in a forked generation process. Activation opens
// no database, so none of these cases needs one.

/** The built bundles the host stages, and the composition it ships. */
const bundlesPath = 'agents/doric/dist/bundles';
const compositionPath = 'agents/doric/composition.json';

/** The structural requirement the shipped composition declares. */
const shippedRequired = async () => {
  const { required } = await readComposition(compositionPath);

  assert.ok(required, 'the shipped composition declares what it requires');
  return required;
};

const structural = async (
  platform: Bundles['platform'],
  logger = pino({ enabled: false }),
) => assertStructural(platform, logger, await shippedRequired());

/** Captured from the pre-migration build (HEAD 20775a6) before any change. */
const fixtures = 'agents/doric/tests/fixtures/stage1-parity';
const generationFixtures = 'agents/doric/tests/fixtures/generation-bundles';

const readFixture = async (name: string) =>
  readFile(join(fixtures, name), 'utf8');

interface SkillFixture {
  readonly name: string;
  readonly skills: readonly {
    readonly name: string;
    readonly alwaysAvailable: boolean;
    readonly allowedTools: readonly string[];
    readonly description: string;
    readonly indexText: string;
  }[];
  readonly tools: readonly {
    readonly name: string;
    readonly alwaysAvailable: boolean;
  }[];
}

interface Host extends Bundles {
  /** The transport's HTTP surface over the booted kernel. */
  readonly url: string;
}

/** Boots a bundles root as the host does and serves its transport. */
const boot = async (
  options: {
    readonly bundles?: string;
    readonly composition?: string;
    /** The composition the host derived, in place of the file. */
    readonly derived?: Composition | { readonly path: string };
    readonly logger?: pino.Logger;
  } = {},
): Promise<Host> => {
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);
  const logger = options.logger ?? pino({ enabled: false });
  const transport = createHostTransport({ app, io, logger });
  const bundles = await startBundles({
    bundlesPath: options.bundles ?? bundlesPath,
    compositionPath: options.composition ?? compositionPath,
    ...(options.derived === undefined ? {} : { composition: options.derived }),
    embedded: [createHostConfig().bundle, transport.bundle],
    logger,
  }).catch(async (error: unknown) => {
    await io.close();
    throw error;
  });
  transport.bind(bundles.platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const stop = bundles.platform.stop.bind(bundles.platform);

  return {
    ...bundles,
    url: `http://127.0.0.1:${String(address.port)}`,
    platform: Object.assign(bundles.platform, {
      stop: async () => {
        // Closing Socket.IO closes the shared HTTP server too.
        await io.close();
        await stop();
      },
    }),
  };
};

const withHost = async (run: (host: Host) => Promise<void>): Promise<void> => {
  const host = await boot();

  try {
    await run(host);
  } finally {
    await host.platform.stop();
  }
};

void test('the default composition exposes the pre-migration tools, in order, byte for byte', async () => {
  await withHost(async (host) => {
    const expected = JSON.parse(await readFixture('tools.json')) as unknown;
    const tools = host.platform.services.use(ToolsV1).list();

    assert.deepEqual(
      tools.map(({ tool }) => {
        const { definition, settings } = tool as unknown as {
          definition: unknown;
          settings: unknown;
        };
        return { definition, settings };
      }),
      expected,
    );
    assert.deepEqual(
      tools.map(({ tool }) => tool.name),
      [
        'cwd',
        'edit',
        'find',
        'grep',
        'terminal',
        'tree',
        'web',
        'write',
        'git',
        'thread-spawn',
        'thread-list',
        'thread-get',
        'thread-events',
        'thread-send',
        'thread-interrupt',
        'thread-terminate',
      ],
    );
  });
});

void test('skills and tools keep their canonical records and availability flags', async () => {
  await withHost(async (host) => {
    const expected = JSON.parse(
      await readFixture('skills.json'),
    ) as readonly SkillFixture[];
    const skills = await host.platform.services.use(SkillsV1).list();
    const tools = host.platform.services.use(ToolsV1).list();

    assert.deepEqual(
      skills.map(({ alwaysAvailable, skill }) => ({
        name: skill.name,
        alwaysAvailable,
        allowedTools: skill.allowedTools,
        description: skill.description,
        indexText: skill.indexText,
      })),
      expected.flatMap(({ skills: entries }) => entries),
    );
    assert.deepEqual(
      tools.map(({ alwaysAvailable, tool }) => ({
        name: tool.name,
        alwaysAvailable,
      })),
      expected.flatMap(({ tools: entries }) => entries),
    );
  });
});

void test('every first-party tool and skill carries an ascending global order key', async () => {
  // D10-5: the model-visible order no longer depends on which bundle owns a
  // tool or skill, so moving one between bundles keeps the request body.
  await withHost(async (host) => {
    const tools = host.platform.services.use(ToolsV1).list();
    const skills = await host.platform.services.use(SkillsV1).list();

    for (const entries of [
      tools.map(({ order }) => order),
      skills.map(({ order }) => order),
    ]) {
      assert.ok(entries.every((order) => order !== undefined));
      assert.deepEqual(
        entries,
        [...entries].sort((left = 0, right = 0) => left - right),
      );
    }

    assert.deepEqual(
      tools
        .filter(({ tool }) => ['terminal', 'web'].includes(tool.name))
        .map(({ order }) => order),
      [500, 700],
    );
    assert.equal(
      skills.find(({ skill }) => skill.name === 'web-research')?.order,
      1200,
    );
  });
});

void test('the catalog and diagnostics list every bundle active, the foundation and the core first, and no tool bundle moves', async () => {
  await withHost(async (host) => {
    const diagnostics = host.platform.diagnostics();

    assert.equal(host.platform.mode, 'normal');
    // The installed bundles: the `postgres` foundation is one of them, the
    // stage-9 desktop bundles (`layout`, `settings`, `chat`, `history`), which
    // have no host part, and since the stage-10 host switch the provider-kind
    // bundles, the `docker` sandbox and the `terminal`, `usage` and
    // `resources` features, and since the desktop switch (WP-10N) the
    // `notifications` bundle, which has no host part, and the `web` bundle. No bundle is
    // quarantined.
    assert.equal(host.bundleCount, 20);
    // `firecracker` is staged beside `docker` but not enabled (D10-9).
    assert.equal(
      diagnostics.bundles.find(({ id }) => id === 'firecracker')?.state,
      'disabled',
    );
    assert.deepEqual(
      Object.fromEntries(
        diagnostics.bundles
          .filter(({ state }) => state !== 'disabled')
          .map(({ id, state, phase }) => [id, [state, phase]]),
      ),
      {
        postgres: ['active', 'foundation'],
        core: ['active', 'core'],
        files: ['active', 'others'],
        web: ['active', 'others'],
        git: ['active', 'others'],
        threads: ['active', 'others'],
        terminal: ['active', 'others'],
        usage: ['active', 'others'],
        resources: ['active', 'others'],
        runtime: ['active', 'others'],
        direct: ['active', 'others'],
        openai: ['active', 'others'],
        openrouter: ['active', 'others'],
        codex: ['active', 'others'],
        docker: ['active', 'others'],
        notifications: ['active', 'others'],
        layout: ['active', 'others'],
        settings: ['active', 'others'],
        chat: ['active', 'others'],
        history: ['active', 'others'],
        'host-config': ['active', 'others'],
        transport: ['active', 'others'],
      },
    );
    const order = host.platform.catalog().order;

    assert.deepEqual(order.slice(0, 2), ['postgres', 'core']);
    // Tools and skills keep the bundle order they always had.
    assert.deepEqual(
      order.filter((id) => ['files', 'git', 'threads'].includes(id)),
      ['files', 'git', 'threads'],
    );
    // A provider activates before what requires it.
    for (const [provider, consumer] of [
      ['direct', 'runtime'],
      ['docker', 'runtime'],
      ['runtime', 'files'],
      ['runtime', 'threads'],
      ['runtime', 'terminal'],
      ['runtime', 'usage'],
      ['runtime', 'resources'],
    ] as const)
      assert.ok(
        order.indexOf(provider) < order.indexOf(consumer),
        `${provider} before ${consumer}: ${order.join(', ')}`,
      );
    await structural(host.platform);
  });
});

void test("the tools of moved bundles keep their names and positions: terminal and web are their bundles'", async () => {
  await withHost(async (host) => {
    const owners = Object.fromEntries(
      host.platform.services
        .use(ToolsV1)
        .list()
        .map(({ tool, bundleId }) => [tool.name, bundleId]),
    );

    assert.equal(owners.terminal, 'terminal');
    assert.equal(owners.cwd, 'files');
    assert.equal(owners.web, 'web');
  });
});

void test('DORIC_SANDBOX_PROVIDER=firecracker boots the shipped composition with the firecracker bundle', async () => {
  const { composition, alternatives } = await hostComposition(
    { DORIC_SANDBOX_PROVIDER: 'firecracker' },
    compositionPath,
  );
  const host = await boot({ derived: composition });

  try {
    assert.deepEqual(alternatives, { sandbox: 'firecracker' });
    const states = Object.fromEntries(
      host.platform.diagnostics().bundles.map(({ id, state }) => [id, state]),
    );

    assert.equal(states.firecracker, 'active');
    assert.equal(states.docker, 'disabled');
    const sandbox = host.platform
      .catalog()
      .contracts.find(({ id }) => id === 'sandbox/v1');
    assert.deepEqual(
      sandbox?.providers.map(({ bundleId }) => bundleId),
      ['firecracker'],
    );
    await structural(host.platform);
  } finally {
    await host.platform.stop();
  }
});

void test('GET /tools answers the pre-migration catalog through the embedded transport', async () => {
  await withHost(async (host) => {
    const response = await fetch(`${host.url}/tools`);
    const expected = (
      JSON.parse(await readFixture('tools.json')) as {
        definition: { name: string; description?: string };
        settings: unknown[];
      }[]
    ).map(({ definition, settings }) => ({
      name: definition.name,
      description: definition.description,
      settings,
    }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { tools: expected });
  });
});

/**
 * A bundles root holding copies of the staged bundles, for altered layouts. It
 * lives inside the workspace, as the staged root does, so the copies resolve
 * their package imports the same way.
 */
const stagedCopy = async (): Promise<string> => {
  const root = await mkdtemp(join('agents/doric/dist-tests', 'bundles-'));

  await cp(bundlesPath, root, { recursive: true });

  return root;
};

const startWith = async (
  root: string,
  change: (composition: { enabled: string[] }) => unknown,
  logger = pino({ enabled: false }),
) => {
  const path = join(root, '..', `${root.split('/').at(-1)}-composition.json`);
  const composition = JSON.parse(await readFile(compositionPath, 'utf8')) as {
    enabled: string[];
  };

  await writeFile(path, JSON.stringify(change(composition)));

  try {
    return await boot({ bundles: root, composition: path, logger });
  } finally {
    await rm(path, { force: true });
  }
};

const recorded = () => {
  const lines: { msg?: string; reason?: string }[] = [];
  const logger = pino(
    { level: 'info' },
    {
      write: (line: string) =>
        lines.push(JSON.parse(line) as { msg?: string; reason?: string }),
    },
  );

  return { lines, logger };
};

void test('a broken tool bundle is quarantined and the others still serve', async () => {
  const root = await stagedCopy();

  try {
    await writeFile(join(root, 'git', 'manifest.json'), '{ "id": 42 }');

    const host = await startWith(root, (composition) => composition);

    try {
      assert.ok(
        host.platform
          .diagnostics()
          .bundles.some(
            ({ state, reasons }) =>
              state === 'quarantined' &&
              reasons.some(({ code }) => code === 'invalid_manifest'),
          ),
      );
      const tools = host.platform.services
        .use(ToolsV1)
        .list()
        .map(({ tool }) => tool.name);
      const skills = await host.platform.services.use(SkillsV1).list();

      assert.ok(!tools.includes('git'));
      assert.ok(tools.includes('thread-spawn'));
      assert.ok(!skills.some(({ skill }) => skill.name.startsWith('git-')));
      // No structural provider was lost, so the host still boots.
      await structural(host.platform);
    } finally {
      await host.platform.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a core that cannot activate puts the host in recovery and boot refuses to continue', async () => {
  const root = await stagedCopy();
  const { lines, logger } = recorded();

  try {
    await rm(join(root, 'core'), { recursive: true, force: true });

    await assert.rejects(
      startWith(root, (composition) => composition, logger),
      (error: unknown) => error instanceof BundleRecoveryError,
    );
    assert.ok(lines.some(({ msg }) => msg === 'Bundle recovery mode'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a composition without the runtime has no structural provider and boot refuses it', async () => {
  const root = await stagedCopy();
  const { lines, logger } = recorded();

  try {
    const host = await startWith(
      root,
      (composition) => ({
        ...composition,
        enabled: composition.enabled.filter((id) => id !== 'runtime'),
      }),
      logger,
    );

    await assert.rejects(
      structural(host.platform, logger),
      (error: unknown) =>
        error instanceof BundleRecoveryError &&
        /runtime\/v1/u.test(error.message) &&
        // The transport requires runtime/v1, so it cannot serve either.
        /transport/u.test(error.message),
    );
    assert.ok(
      lines.some(
        ({ msg, reason }) =>
          msg === 'Bundle recovery mode' &&
          reason?.includes('runtime/v1') === true,
      ),
    );
    // The refusal stopped the platform; stopping again is a no-op.
    await host.platform.stop();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('a generation that cannot start leaves no structural provider and boot refuses it', {
  timeout: 60_000,
}, async () => {
  const root = await stagedCopy();

  try {
    await cp(
      join(generationFixtures, 'crash-on-activate'),
      join(root, 'crash-on-activate'),
      { recursive: true },
    );
    const host = await startWith(root, (composition) => ({
      ...composition,
      enabled: [...composition.enabled, 'crash-on-activate'],
    }));

    try {
      assert.equal(
        host.platform.diagnostics().bundles.find(({ id }) => id === 'runtime')
          ?.state,
        'quarantined',
      );
      await assert.rejects(
        structural(host.platform),
        (error: unknown) =>
          error instanceof BundleRecoveryError &&
          ['runtime/v1', 'executor/v1', 'sandbox/v1'].every((id) =>
            error.message.includes(id),
          ),
      );
    } finally {
      await host.platform.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('after boot, an activation that leaves no structural provider takes the fatal path', async () => {
  const host = await boot();
  const { lines, logger } = recorded();

  try {
    const catalog = host.platform.catalog();
    let active: ((generation: number) => void) | undefined;
    let current = catalog;
    const reasons: string[] = [];
    // The real catalog, then the one a generation that exhausted its
    // respawns leaves: its bundles quarantined, an empty view active.
    const platform = {
      catalog: () => current,
      generations: {
        onActive: (listener: (generation: number) => void) => {
          active = listener;
          return () => {
            active = undefined;
          };
        },
      },
    } as unknown as Parameters<typeof watchStructural>[0];
    const stop = watchStructural(
      platform,
      logger,
      (reason) => {
        reasons.push(reason);
      },
      await shippedRequired(),
    );

    active?.(1);
    assert.deepEqual(reasons, []);

    current = {
      ...catalog,
      bundles: catalog.bundles.map((bundle) =>
        ['runtime', 'direct', 'docker'].includes(bundle.id)
          ? { ...bundle, state: 'quarantined' as const }
          : bundle,
      ),
    };
    active?.(1);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0] ?? '', /runtime\/v1, executor\/v1, sandbox\/v1/u);
    assert.ok(lines.some(({ msg }) => msg === 'Bundle recovery mode'));

    stop();
    assert.equal(active, undefined);
  } finally {
    await host.platform.stop();
  }
});

void test('the bundles root and composition come from the environment or the host defaults', () => {
  assert.deepEqual(bundlePaths({}, '/opt/doric/agents/doric/dist/src'), {
    bundlesPath: '/opt/doric/agents/doric/dist/bundles',
    compositionPath: '/opt/doric/agents/doric/composition.json',
  });
  assert.deepEqual(
    bundlePaths(
      { DORIC_BUNDLES_PATH: '/srv/bundles', DORIC_COMPOSITION: '/srv/c.json' },
      '/opt/doric/agents/doric/dist/src',
    ),
    { bundlesPath: '/srv/bundles', compositionPath: '/srv/c.json' },
  );
});

void test("the structural requirement is the composition's: a contract it names that no provider serves refuses the boot", async () => {
  const host = await boot();

  try {
    await assert.rejects(
      assertStructural(host.platform, pino({ enabled: false }), {
        contracts: ['nothing/v1'],
        bundles: [],
      }),
      (error: unknown) =>
        error instanceof BundleRecoveryError &&
        error.message.includes('structural providers unavailable: nothing/v1'),
    );
  } finally {
    await host.platform.stop();
  }
});
