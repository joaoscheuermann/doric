import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';

import { type Composition, readComposition } from 'bundle';
import { SecretsV1, SkillsV1, ToolsV1 } from 'bundle/contracts';
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

// Build doric first: these tests boot the bundles the host stages in
// dist/bundles with the composition it ships, through the real loader, and
// with the kernel's embedded `host-config` and `transport`, as the host does.
// The installed bundles run in a forked generation process. Activation opens
// no database, so most of these cases need none. The default tool and skill
// lists do (openui.md stage 3, D24): they follow the Generative UI setting,
// read through `settings/v1`, and `ask` is withheld from the host's start
// steps (`platform.start()`), which connect the storage backend.

/** The built bundles the host stages, and the composition it ships. */
const bundlesPath = 'app/backend/doric-host/dist/bundles';
const compositionPath = 'app/backend/doric-host/composition.json';

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
const fixtures = 'app/backend/doric-host/tests/fixtures/stage1-parity';
const generationFixtures =
  'app/backend/doric-host/tests/fixtures/generation-bundles';

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
  const bundles = await startBundles({
    bundlesPath: options.bundles ?? bundlesPath,
    compositionPath: options.composition ?? compositionPath,
    ...(options.derived === undefined ? {} : { composition: options.derived }),
    network: { http: app, server, sockets: io },
    logger,
  }).catch(async (error: unknown) => {
    await io.close();
    throw error;
  });
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

/** The options of a case that boots over a database. */
const needsDatabase = {
  skip:
    process.env.DORIC_TEST_DATABASE_URL === undefined
      ? 'Requires DORIC_TEST_DATABASE_URL'
      : false,
  timeout: 180_000,
} as const;

/**
 * Boots over a fresh database and runs the host's start steps, as `main` does
 * after the boot (`src/index.ts`); `start` boots another layout.
 */
const withStartedHost = async (
  run: (host: Host) => Promise<void>,
  start: () => Promise<Host> = () => boot(),
): Promise<void> => {
  const connectionString = process.env.DORIC_TEST_DATABASE_URL;
  assert.ok(connectionString);
  const { freshDatabase } = await import('./helpers/host.js');
  const { credentialKey } = await import('./helpers/platform.js');
  const database = await freshDatabase(connectionString);
  const saved = {
    url: process.env.DORIC_DATABASE_URL,
    key: process.env.DORIC_CREDENTIAL_KEY,
  };
  process.env.DORIC_DATABASE_URL = database.url;
  process.env.DORIC_CREDENTIAL_KEY = credentialKey;

  try {
    const host = await start();

    try {
      await host.platform.start();
      await run(host);
    } finally {
      await host.platform.stop();
    }
  } finally {
    process.env.DORIC_DATABASE_URL = saved.url;
    process.env.DORIC_CREDENTIAL_KEY = saved.key;
    if (saved.url === undefined) delete process.env.DORIC_DATABASE_URL;
    if (saved.key === undefined) delete process.env.DORIC_CREDENTIAL_KEY;
    await database.close();
  }
};

/** Writes the Generative UI setting as a window writes it. */
const setGenerativeUi = async (host: Host, enabled: boolean) => {
  const { ref } = await import('bundle/contracts');
  await host.platform.services
    .use(
      ref<{ set(value: { enabled: boolean }): Promise<unknown> }>(
        'openui.setting/v1',
      ),
    )
    .set({ enabled });
};

/** The tool and skill names the registries list now. */
const listed = async (host: Host) => ({
  tools: host.platform.services
    .use(ToolsV1)
    .list()
    .map(({ tool }) => tool.name),
  skills: (await host.platform.services.use(SkillsV1).list()).map(
    ({ skill }) => skill.name,
  ),
});

/** Polls until `check` holds; a setting reaches the bundles through a subscription. */
const eventually = async (
  check: () => Promise<boolean>,
  message: () => Promise<string>,
): Promise<void> => {
  for (const end = Date.now() + 10_000; Date.now() < end; ) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(await message());
};

void test('the default composition registers the GIT and MCP_TOKEN kinds when the git and mcp bundles activate', async () => {
  await withHost(async (host) => {
    const kinds = await host.platform.services.use(SecretsV1).kinds();

    assert.deepEqual(
      kinds.map(({ id }) => id),
      ['API_TOKEN', 'USERNAME_PASSWORD', 'GIT', 'MCP_TOKEN'],
    );
    assert.deepEqual(
      kinds.find(({ id }) => id === 'MCP_TOKEN'),
      {
        id: 'MCP_TOKEN',
        required: ['secret'],
        optional: [],
        label: 'MCP token',
      },
    );
    assert.deepEqual(
      kinds.find(({ id }) => id === 'GIT'),
      {
        id: 'GIT',
        required: ['username', 'email'],
        optional: [],
        label: 'Git identity',
      },
    );
  });
});

// B13 (openui.md stage 3): with the default setting the list has neither
// `ask` nor `papercraft_preview`.
void test(
  'the default composition exposes the pre-migration tools, in order, byte for byte',
  needsDatabase,
  async () => {
    await withStartedHost(async (host) => {
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
        ],
      );
    });
  },
);

// B13 (openui.md stage 3): with the default setting the skills are `openui`
// and `papercraft`, not `papercraft-preview`.
void test(
  'skills and tools keep their canonical records and availability flags',
  needsDatabase,
  async () => {
    await withStartedHost(async (host) => {
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
  },
);

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
    // bundles, among them `claude` (the Claude Code OAuth provider), the
    // `docker` sandbox and the `terminal`, `usage`,
    // `resources` and `screen` features, the `claude-login` feature (the
    // in-app Claude sign-in), and since the desktop switch (WP-10N) the
    // `notifications` bundle, which has no host part, and the `web` bundle. The
    // `screen-relay` bundle is one too: it is the resident half of the screen,
    // which serves the relay on the host's own listener, and the `artifacts`,
    // `comments` and `papercraft` features are the review registry, its
    // anchored comments and the live preview over them. The `mcp` feature is
    // the Project's MCP servers and the tools they bring. The `openui`
    // feature draws UI in the conversation (OpenUI slice 1). No bundle is
    // quarantined.
    assert.equal(host.bundleCount, 31);
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
        screen: ['active', 'others'],
        'screen-relay': ['active', 'others'],
        runtime: ['active', 'others'],
        default: ['active', 'others'],
        openai: ['active', 'others'],
        openrouter: ['active', 'others'],
        codex: ['active', 'others'],
        claude: ['active', 'others'],
        'claude-login': ['active', 'others'],
        docker: ['active', 'others'],
        notifications: ['active', 'others'],
        layout: ['active', 'others'],
        settings: ['active', 'others'],
        chat: ['active', 'others'],
        history: ['active', 'others'],
        'host-config': ['active', 'others'],
        transport: ['active', 'others'],
        artifacts: ['active', 'others'],
        comments: ['active', 'others'],
        openui: ['active', 'others'],
        papercraft: ['active', 'others'],
        mcp: ['active', 'others'],
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
      ['default', 'runtime'],
      ['docker', 'runtime'],
      ['runtime', 'files'],
      ['runtime', 'threads'],
      ['runtime', 'terminal'],
      ['runtime', 'usage'],
      ['runtime', 'resources'],
      ['runtime', 'screen'],
      ['screen-relay', 'screen'],
      ['claude-login', 'settings'],
      ['artifacts', 'papercraft'],
      ['comments', 'papercraft'],
      ['runtime', 'mcp'],
      // openui requires chat.views/v1 and chat.send/v1 (chat), the runtime's
      // threads and hooks, and the core's hooks, events, skills and settings.
      ['chat', 'openui'],
      ['runtime', 'openui'],
      ['core', 'openui'],
      // papercraft 1.3.0 requires openui's generative-ui, setting and
      // programs contracts, chat.views/v1, the runtime's threads and hooks,
      // and the core's skills, settings and events.
      ['openui', 'papercraft'],
      ['chat', 'papercraft'],
      ['runtime', 'papercraft'],
      ['core', 'papercraft'],
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

void test(
  'GET /tools answers the pre-migration catalog through the installed transport',
  needsDatabase,
  async () => {
    await withStartedHost(async (host) => {
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
  },
);

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
        ['runtime', 'default', 'docker'].includes(bundle.id)
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

// PC23 (papercraft-openui.md D28, R36): with the real `default` and
// `papercraft` bundles and the setting on, papercraft finds the skill load in
// the Thread log by `default`'s tool name and input. Prompt 1 loads the skill;
// prompt 2's start finds the load and starts a library job; prompt 3's first
// model request carries the instruct of that job's failure, which has no root,
// so only the skill load read from the log can have brought it. A prompt runs
// only on a Project that holds a sandbox lease, so `docker` is swapped for the
// `nodeless-sandbox` fixture: its Project is ready without Docker, and no
// `node` in it makes the library job fail. Prompts need the database.
void test('PC23: a papercraft skill load read from the log brings the library instruct at the second prompt start', {
  skip:
    process.env.DORIC_TEST_DATABASE_URL === undefined
      ? 'Requires DORIC_TEST_DATABASE_URL'
      : false,
  timeout: 180_000,
}, async () => {
  const connectionString = process.env.DORIC_TEST_DATABASE_URL;
  assert.ok(connectionString);
  const { freshDatabase } = await import('./helpers/host.js');
  const { credentialKey } = await import('./helpers/platform.js');
  const { papercraftPrompts, scriptedEndpoint, scriptedModel } = await import(
    './helpers/integration-provider.js'
  );
  const { defaultConfig } = await import('host-config/testing');
  const { ref } = await import('bundle/contracts');
  const database = await freshDatabase(connectionString);
  const model = await scriptedEndpoint();
  const saved = {
    url: process.env.DORIC_DATABASE_URL,
    key: process.env.DORIC_CREDENTIAL_KEY,
  };
  process.env.DORIC_DATABASE_URL = database.url;
  process.env.DORIC_CREDENTIAL_KEY = credentialKey;

  const root = await stagedCopy();

  try {
    await cp(
      join(generationFixtures, 'nodeless-sandbox'),
      join(root, 'nodeless-sandbox'),
      { recursive: true },
    );
    // The contract schema the fixture declares is the one the build staged.
    await cp(
      join(root, 'docker', 'schemas'),
      join(root, 'nodeless-sandbox', 'schemas'),
      { recursive: true },
    );
    const host = await startWith(root, (composition) => ({
      ...composition,
      enabled: composition.enabled.map((id) =>
        id === 'docker' ? 'nodeless-sandbox' : id,
      ),
    }));

    try {
      const request = async <T>(
        path: string,
        method = 'GET',
        body?: unknown,
      ): Promise<T> => {
        const response = await fetch(`${host.url}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.ok(
          response.ok,
          `${method} ${path}: ${await response.clone().text()}`,
        );
        return (
          response.status === 204 ? undefined : await response.json()
        ) as T;
      };
      const credential = await request<{ id: string }>('/credentials', 'POST', {
        kind: 'API_TOKEN',
        name: 'scripted',
        secret: 'sk-scripted',
      });
      await request('/config', 'PUT', {
        ...defaultConfig,
        providers: [
          {
            id: 'scripted',
            kind: 'openrouter',
            configuration: { endpoint: model.endpoint, token: credential.id },
            models: [{ name: scriptedModel, reasonings: [] }],
          },
        ],
        models: { execution: { providerId: 'scripted', model: scriptedModel } },
      });
      // The Generative UI setting, written as a window writes it.
      await host.platform.services
        .use(
          ref<{ set(value: { enabled: boolean }): Promise<unknown> }>(
            'openui.setting/v1',
          ),
        )
        .set({ enabled: true });

      const project = await request<{ id: string }>('/projects', 'POST', {
        name: 'PC23',
      });
      const thread = await request<{ id: string }>(
        `/projects/${project.id}/threads`,
        'POST',
        { name: 'PC23 thread' },
      );
      const finished = async (promptId: string) => {
        for (const end = Date.now() + 120_000; Date.now() < end; ) {
          const { events } = await request<{
            events: { type: string; promptId: string }[];
          }>(`/threads/${thread.id}/events`);
          if (
            events.some(
              (event) =>
                event.type === 'prompt.finished' && event.promptId === promptId,
            )
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        assert.fail(`prompt ${promptId} did not finish`);
      };
      for (const prompt of [
        papercraftPrompts.load,
        papercraftPrompts.second,
        papercraftPrompts.third,
      ]) {
        const { promptId } = await request<{ promptId: string }>(
          `/threads/${thread.id}/prompt`,
          'POST',
          { prompt },
        );
        await finished(promptId);
      }

      assert.deepEqual(model.failures, []);
      const third = model.requests.find(({ messages }) =>
        JSON.stringify(messages).includes(papercraftPrompts.third),
      );
      assert.ok(third, 'prompt 3 reached the model');
      assert.ok(
        JSON.stringify(third.messages).includes(
          'The repository library could not be checked: The sandbox could not run the library job: the sandbox has no `node`',
        ),
        'prompt 3 carries the library instruct',
      );
    } finally {
      await host.platform.stop();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    process.env.DORIC_DATABASE_URL = saved.url;
    process.env.DORIC_CREDENTIAL_KEY = saved.key;
    if (saved.url === undefined) delete process.env.DORIC_DATABASE_URL;
    if (saved.key === undefined) delete process.env.DORIC_CREDENTIAL_KEY;
    await model.close();
    await database.close();
  }
});

// B13 and PC20 (openui.md, papercraft-openui.md stage 3): with the default
// setting, after the host's start steps, neither `ask` nor `papercraft_preview`
// is a tool and the skills are `openui` and `papercraft`, not
// `papercraft-preview`.
void test(
  'B13, PC20: with the default setting the tools have no ask and no papercraft_preview, and the skills have openui and papercraft and no papercraft-preview',
  needsDatabase,
  async () => {
    await withStartedHost(async (host) => {
      const { tools, skills } = await listed(host);

      assert.ok(!tools.includes('ask'), tools.join(', '));
      assert.ok(!tools.includes('papercraft_preview'), tools.join(', '));
      assert.ok(skills.includes('openui'), skills.join(', '));
      assert.ok(skills.includes('papercraft'), skills.join(', '));
      assert.ok(!skills.includes('papercraft-preview'), skills.join(', '));
    });
  },
);

// PC20 and B16's lists (stage 3): with the setting off, `ask`,
// `papercraft_preview` and `papercraft-preview` are listed and neither
// `openui` nor `papercraft`; on again, none of the three.
void test(
  'PC20, B16: turning the setting off lists ask, papercraft_preview and papercraft-preview and neither openui nor papercraft; on again lists none of the three',
  needsDatabase,
  async () => {
    await withStartedHost(async (host) => {
      const off = async () => {
        const { tools, skills } = await listed(host);
        return (
          tools.includes('ask') &&
          tools.includes('papercraft_preview') &&
          skills.includes('papercraft-preview') &&
          !skills.includes('openui') &&
          !skills.includes('papercraft')
        );
      };
      const on = async () => {
        const { tools, skills } = await listed(host);
        return (
          !tools.includes('ask') &&
          !tools.includes('papercraft_preview') &&
          !skills.includes('papercraft-preview') &&
          skills.includes('openui') &&
          skills.includes('papercraft')
        );
      };
      const describe = async () => JSON.stringify(await listed(host));

      await setGenerativeUi(host, false);
      await eventually(off, describe);

      await setGenerativeUi(host, true);
      await eventually(on, describe);
    });
  },
);

// B16 (openui.md stage 3): a prompt started after the setting turned off
// offers `ask` and `papercraft_preview` and lists `papercraft-preview`, and
// neither `openui` nor `papercraft`; a prompt that started before the change
// keeps the tools and skills it started with. A prompt runs only on a Project
// that holds a sandbox lease, so `docker` is swapped for the
// `nodeless-sandbox` fixture, as PC23 does.
void test(
  'B16: with the setting set to false, a prompt started after the change offers the old tools and skills; a prompt started before keeps its own',
  needsDatabase,
  async () => {
    const { scriptedEndpoint, scriptedModel, settingPrompts } = await import(
      './helpers/integration-provider.js'
    );
    const { defaultConfig } = await import('host-config/testing');
    const model = await scriptedEndpoint();
    const root = await stagedCopy();

    try {
      await cp(
        join(generationFixtures, 'nodeless-sandbox'),
        join(root, 'nodeless-sandbox'),
        { recursive: true },
      );
      await cp(
        join(root, 'docker', 'schemas'),
        join(root, 'nodeless-sandbox', 'schemas'),
        { recursive: true },
      );

      await withStartedHost(
        async (host) => {
          const request = async <T>(
            path: string,
            method = 'GET',
            body?: unknown,
          ): Promise<T> => {
            const response = await fetch(`${host.url}${path}`, {
              method,
              headers: { 'content-type': 'application/json' },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            assert.ok(
              response.ok,
              `${method} ${path}: ${await response.clone().text()}`,
            );
            return (
              response.status === 204 ? undefined : await response.json()
            ) as T;
          };
          const credential = await request<{ id: string }>(
            '/credentials',
            'POST',
            { kind: 'API_TOKEN', name: 'scripted', secret: 'sk-scripted' },
          );
          await request('/config', 'PUT', {
            ...defaultConfig,
            providers: [
              {
                id: 'scripted',
                kind: 'openrouter',
                configuration: {
                  endpoint: model.endpoint,
                  token: credential.id,
                },
                models: [{ name: scriptedModel, reasonings: [] }],
              },
            ],
            models: {
              execution: { providerId: 'scripted', model: scriptedModel },
            },
          });
          const project = await request<{ id: string }>('/projects', 'POST', {
            name: 'B16',
          });
          const thread = await request<{ id: string }>(
            `/projects/${project.id}/threads`,
            'POST',
            { name: 'B16 thread' },
          );
          const finished = async (promptId: string) => {
            for (const end = Date.now() + 120_000; Date.now() < end; ) {
              const { events } = await request<{
                events: { type: string; promptId: string }[];
              }>(`/threads/${thread.id}/events`);
              if (
                events.some(
                  (event) =>
                    event.type === 'prompt.finished' &&
                    event.promptId === promptId,
                )
              ) {
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            assert.fail(`prompt ${promptId} did not finish`);
          };

          // Prompt A starts with the default setting; its first request waits.
          const before = await request<{ promptId: string }>(
            `/threads/${thread.id}/prompt`,
            'POST',
            { prompt: settingPrompts.before },
          );
          await model.beforeHeld;

          await setGenerativeUi(host, false);
          await eventually(
            async () => {
              const { tools, skills } = await listed(host);
              return (
                tools.includes('ask') &&
                tools.includes('papercraft_preview') &&
                skills.includes('papercraft-preview')
              );
            },
            async () => JSON.stringify(await listed(host)),
          );
          model.releaseBefore();
          await finished(before.promptId);

          const after = await request<{ promptId: string }>(
            `/threads/${thread.id}/prompt`,
            'POST',
            { prompt: settingPrompts.after },
          );
          await finished(after.promptId);

          assert.deepEqual(model.failures, []);
          const system = (
            messages: readonly { role: string; content?: unknown }[],
          ) =>
            JSON.stringify(
              messages.find(({ role }) => role === 'system')?.content ?? '',
            );
          const row = (name: string) => `| ${name} |`;

          // A's request after the change, the one that follows its tool result.
          const late = model.requests.find(
            ({ messages, tools }) =>
              tools.length > 0 &&
              JSON.stringify(messages).includes(settingPrompts.before) &&
              messages.at(-1)?.role === 'tool',
          );
          assert.ok(late, 'prompt A made a request after the change');
          assert.ok(!late.tools.includes('ask'), late.tools.join(', '));
          assert.ok(
            !late.tools.includes('papercraft_preview'),
            late.tools.join(', '),
          );
          assert.ok(system(late.messages).includes(row('openui')));
          assert.ok(system(late.messages).includes(row('papercraft')));
          assert.ok(!system(late.messages).includes(row('papercraft-preview')));

          const fresh = model.requests.find(
            ({ messages, tools }) =>
              tools.length > 0 &&
              JSON.stringify(messages).includes(settingPrompts.after),
          );
          assert.ok(fresh, 'prompt B reached the model');
          assert.ok(fresh.tools.includes('ask'), fresh.tools.join(', '));
          assert.ok(
            fresh.tools.includes('papercraft_preview'),
            fresh.tools.join(', '),
          );
          assert.ok(system(fresh.messages).includes(row('papercraft-preview')));
          assert.ok(!system(fresh.messages).includes(row('openui')));
          assert.ok(!system(fresh.messages).includes(row('papercraft')));
        },
        () =>
          startWith(root, (composition) => ({
            ...composition,
            enabled: composition.enabled.map((id) =>
              id === 'docker' ? 'nodeless-sandbox' : id,
            ),
          })),
      );
    } finally {
      model.releaseBefore();
      await rm(root, { recursive: true, force: true });
      await model.close();
    }
  },
);
