import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import type { DescService } from '@bufbuild/protobuf';
import { ContractError, fromConnectError } from 'bundle/contracts';
import { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { type Platform, readStagedCatalogIndex } from 'bundle/platform';
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
  bundlePid,
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

// The cases C3-4 dropped with the kernel (spec revision 6.31; contracts
// `s62d.md` §0.6, §5 tests 11-16, decision Q5): none reads a `doric.api.*`
// method, so each calls the basic contracts and the bundles' own contracts
// as `doric` on `startHostPlatform`.

/** The stage-1 parity fixtures, kept byte for byte since the kernel. */
const readFixture = (name: string): Promise<string> =>
  readFile(
    join('app/backend/doric-host/tests/fixtures/stage1-parity', name),
    'utf8',
  );

/** One group of `skills.json`: the skills and tools of one owner, in order. */
interface SkillFixture {
  readonly label: string;
  readonly skills: readonly unknown[];
  readonly tools: readonly unknown[];
}

/** The Doric code of a `doric` call's failure, or `'none'` when it answered. */
const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return 'none';
  } catch (error) {
    return error instanceof Error && error.name === 'ConnectError'
      ? fromConnectError(error as Parameters<typeof fromConnectError>[0]).code
      : String(error);
  }
};

/** The ids of the bundles that provide `contract` in the booted resolution. */
const providersOf = (host: HostPlatform, contract: string): string[] =>
  (
    host.resolved.contracts.find(({ id }) => id === contract)?.providers ?? []
  ).map(({ bundleId }) => bundleId);

/**
 * The service `fullName` of a staged bundle's own contract, read from its
 * `descriptors.binpb` (the host does not import the bundles' packages).
 */
const stagedService = async (
  bundleId: string,
  fullName: string,
): Promise<DescService> => {
  const index = await readStagedCatalogIndex(bundlesPath, [bundleId]);
  const service = index.service(fullName)?.service;
  assert.ok(service, `${bundleId} stages ${fullName}`);
  return service;
};

void test(
  'secrets/v1.Kinds as doric lists API_TOKEN, USERNAME_PASSWORD, GIT and MCP_TOKEN with the git and mcp definitions',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const { kinds } = await host.platform.client(SecretsService).kinds({});
      const plain = kinds.map(({ id, required, optional, label }) => ({
        id,
        required: [...required],
        optional: [...optional],
        label,
      }));

      assert.deepEqual(
        plain.map(({ id }) => id),
        ['API_TOKEN', 'USERNAME_PASSWORD', 'GIT', 'MCP_TOKEN'],
      );
      assert.deepEqual(
        plain.find(({ id }) => id === 'MCP_TOKEN'),
        {
          id: 'MCP_TOKEN',
          required: ['secret'],
          optional: [],
          label: 'MCP token',
        },
      );
      assert.deepEqual(
        plain.find(({ id }) => id === 'GIT'),
        {
          id: 'GIT',
          required: ['username', 'email'],
          optional: [],
          label: 'Git identity',
        },
      );
    });
  },
);

// Stage-1 parity: the messages' JSON equals the kernel's JSON of the
// fixtures; a definition's schemas are JSON text in `tools/v1`, parsed here.
void test(
  'tools/v1.List and skills/v1.List as doric keep the stage-1 definitions, settings, records and availability flags',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const tools = (await host.platform.client(ToolsService).list({})).tools;
      const skills = (await host.platform.client(SkillsService).list({}))
        .skills;

      assert.deepEqual(
        tools.map(({ tool }) => {
          const definition = tool?.definition;
          assert.ok(definition, tool?.name);
          return {
            definition: {
              name: definition.name,
              ...(definition.description === undefined
                ? {}
                : { description: definition.description }),
              inputSchema: JSON.parse(definition.inputSchema) as unknown,
              outputSchema: JSON.parse(definition.outputSchema) as unknown,
              ...(definition.strict === undefined
                ? {}
                : { strict: definition.strict }),
            },
            settings: [...(tool?.settings ?? [])],
          };
        }),
        JSON.parse(await readFixture('tools.json')) as unknown,
      );

      const groups = JSON.parse(
        await readFixture('skills.json'),
      ) as readonly SkillFixture[];
      assert.deepEqual(
        skills.map(({ alwaysAvailable, skill }) => ({
          name: skill?.name,
          alwaysAvailable,
          allowedTools: [...(skill?.allowedTools ?? [])],
          description: skill?.description,
          indexText: skill?.indexText,
        })),
        groups.flatMap(({ skills: entries }) => entries),
      );
      assert.deepEqual(
        tools.map(({ alwaysAvailable, tool }) => ({
          name: tool?.name,
          alwaysAvailable,
        })),
        groups.flatMap(({ tools: entries }) => entries),
      );
    });
  },
);

// S62d3 addendum 2 (SK-2, B.4 test 2): each host part registers its own
// `src/skills/` as itself, so `List` names the bundle whose directory holds
// the skill; `allowedTools` naming another bundle's tool is stored as given
// (SK-1).
void test(
  'skills/v1.List as doric names the bundle that registers each own skill, and keeps cross-bundle allowedTools as given',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const skills = (await host.platform.client(SkillsService).list({}))
        .skills;
      const ownerOf = (name: string): string[] =>
        skills
          .filter(({ skill }) => skill?.name === name)
          .map(({ bundleId }) => bundleId);

      assert.deepEqual(
        Object.fromEntries(
          [
            'web-research',
            'git-cloning',
            'goal-directed-tool-use',
            'thread-delegation',
            'coding-workflow',
          ].map((name) => [name, ownerOf(name)]),
        ),
        {
          'web-research': ['web'],
          'git-cloning': ['git'],
          'goal-directed-tool-use': ['files'],
          'thread-delegation': ['threads'],
          'coding-workflow': ['default'],
        },
      );

      const synthesis = skills.find(
        ({ skill }) => skill?.name === 'evidence-grounded-synthesis',
      );
      assert.equal(synthesis?.bundleId, 'files');
      assert.ok(
        synthesis?.skill?.allowedTools.includes('web'),
        JSON.stringify(synthesis?.skill?.allowedTools),
      );
    });
  },
);

// S62d3 addendum 2 (SK-2, B.4 test 3): the registrations are the instance's,
// so a killed `web` process takes `web-research` with it (`InstanceGone`) and
// its next incarnation registers it again, once.
void test(
  'a killed web process: its next incarnation lists web-research again, from web, exactly once',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const owners = async (): Promise<string[]> =>
        (await host.platform.client(SkillsService).list({})).skills
          .filter(({ skill }) => skill?.name === 'web-research')
          .map(({ bundleId }) => bundleId);
      /** Polls `check` every 20 ms until it holds; fails after 60 s. */
      const eventually = async (
        check: () => Promise<boolean>,
        what: string,
      ): Promise<void> => {
        const deadline = Date.now() + 60_000;
        while (!(await check())) {
          assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };

      assert.deepEqual(await owners(), ['web']);

      const killed = await bundlePid(bundlesPath, process.pid, 'web');
      assert.ok(killed !== undefined, 'web runs in a process');
      process.kill(killed, 'SIGKILL');

      // The first incarnation is gone: its skill went with it.
      await eventually(
        async () => (await owners()).length === 0,
        'web-research to go with the killed process',
      );
      // The next incarnation runs and has registered it again.
      await eventually(async () => {
        const pid = await bundlePid(bundlesPath, process.pid, 'web');
        return pid !== undefined && pid !== killed;
      }, 'the next web process');
      await eventually(
        async () => (await owners()).length > 0,
        'web-research from the next incarnation',
      );
      assert.deepEqual(await owners(), ['web']);
    });
  },
);

// B14 (openui.md stage 4, D24; conversation-openui.md D30; papercraft-openui.md
// D25).
void test(
  'B14: the default host has no ask, papercraft_preview or papercraft-preview, has openui and papercraft, and serves neither threads.ask/v1, openui.setting/v1 nor the openui.generative-ui/v1 space',
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const tools = await listedTools(host);
      const skills = (
        await host.platform.client(SkillsService).list({})
      ).skills.map(({ skill }) => skill?.name ?? '');

      assert.ok(!tools.includes('ask'), tools.join(', '));
      assert.ok(!tools.includes('papercraft_preview'), tools.join(', '));
      assert.ok(skills.includes('openui'), skills.join(', '));
      assert.ok(skills.includes('papercraft'), skills.join(', '));
      assert.ok(!skills.includes('papercraft-preview'), skills.join(', '));

      assert.deepEqual(providersOf(host, 'threads.ask/v1'), []);
      assert.deepEqual(providersOf(host, 'openui.setting/v1'), []);
      assert.equal(
        await codeOf(() =>
          host.platform
            .client(SettingsService)
            .entry({ id: 'openui.generative-ui/v1' }),
        ),
        'unknown_settings',
      );
    });
  },
);

void test(
  'DORIC_SANDBOX_PROVIDER=firecracker boots the shipped composition with firecracker active, docker disabled and firecracker the only sandbox/v1 provider',
  needsDatabase,
  async () => {
    // `withHost` resolves only once the boot passed the structural check.
    await withHost(
      async (host) => {
        const states = Object.fromEntries(
          host.diagnostics
            .snapshot()
            .bundles.map(({ id, state }) => [id, state]),
        );

        assert.equal(states.firecracker, 'active');
        assert.equal(states.docker, 'disabled');
        assert.deepEqual(providersOf(host, 'sandbox/v1'), ['firecracker']);
      },
      { variables: { DORIC_SANDBOX_PROVIDER: 'firecracker' } },
    );
  },
);

/** A listening server on a free port of 127.0.0.1, and its port. */
const listening = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    );
  });

/**
 * A screen upstream, as xpra: answers every request 200 with a body naming
 * its method and target; accepts every WebSocket upgrade and echoes the bytes
 * after it.
 */
const screenUpstream = async (): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> => {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`upstream ${request.method ?? ''} ${request.url ?? ''}`);
  });

  server.on('upgrade', (_request: IncomingMessage, socket: Socket) => {
    sockets.add(socket);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        '\r\n',
    );
    socket.on('data', (chunk: Buffer) => socket.write(chunk));
    socket.on('error', () => undefined);
  });

  const port = await listening(server);

  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

/** Opens a WebSocket upgrade of `path` on `port`, then answers the echo of `bytes`. */
const upgradeEcho = (
  port: number,
  path: string,
  bytes: Buffer,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });

    client.on('error', reject);
    client.on('response', (response) => {
      response.resume();
      reject(new Error(`the upgrade answered ${String(response.statusCode)}`));
    });
    client.on('upgrade', (response, socket: Socket) => {
      if (response.statusCode !== 101) {
        socket.destroy();
        reject(
          new Error(`the upgrade answered ${String(response.statusCode)}`),
        );
        return;
      }

      let received = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= bytes.length) {
          socket.destroy();
          resolve(received);
        }
      });
      socket.write(bytes);
    });
    client.end();
  });

// T3.2: the screen relay's `/screen/` prefix through the gateway's public
// listener (contracts `s62d.md` §5 test 15).
void test(
  'T3.2: a token exposed through screen.relay/v1 proxies HTTP and a WebSocket upgrade on the public listener, and an unknown token answers 404',
  needsDatabase,
  async () => {
    const upstream = await screenUpstream();

    try {
      await withHost(async (host) => {
        assert.ok(host.platform.publicPort);
        const base = `http://127.0.0.1:${String(host.platform.publicPort)}`;
        const token = randomUUID();
        const relay = host.platform.client(
          await stagedService(
            'screen-relay',
            'doric.screen.relay.v1.RelayService',
          ),
        ) as unknown as {
          expose(request: {
            token: string;
            host: string;
            port: number;
          }): Promise<unknown>;
        };

        await relay.expose({ token, host: '127.0.0.1', port: upstream.port });

        const answer = await fetch(`${base}/screen/${token}/x?y=1`);
        assert.equal(answer.status, 200);
        assert.equal(await answer.text(), 'upstream GET /x?y=1');

        const bytes = Buffer.from('relayed both ways');
        assert.deepEqual(
          await upgradeEcho(
            host.platform.publicPort,
            `/screen/${token}/ws`,
            bytes,
          ),
          bytes,
        );

        const unknown = await fetch(`${base}/screen/unknown/`);
        assert.equal(unknown.status, 404);
        await unknown.body?.cancel();
      });
    } finally {
      await upstream.close();
    }
  },
);

/** A bundle's source asset as `stage --dev` serves it: `<bundle dir>/<path>`. */
const sourceAsset = (bundleDir: string, path: string): Promise<string> =>
  readFile(join(bundleDir, path), 'utf8');

/** The `description` of a definition file's front matter. */
const descriptionOf = (text: string): string | undefined =>
  /^---\n[\s\S]*?^description: (.*)$[\s\S]*?^---$/m.exec(text)?.[1];

// T3.11 with T7 (contracts `s62d.md` §5 test 16): under `stage --dev` each
// host part reads its files through `context.assets` from its bundle
// directory, and `papercraft`'s skill (which needs `comment_reply`) is
// registered. The compile half (one esbuild build and one Tailwind compile)
// needs a Project sandbox, so it is the end-to-end test's (Q8).
void test(
  "T3.11: openui's and papercraft's skills and default's built-in agents are read through context.assets under stage --dev",
  needsDatabase,
  async () => {
    await withHost(async (host) => {
      const skills = (await host.platform.client(SkillsService).list({}))
        .skills;
      const bodyOf = (name: string): string | undefined =>
        skills.find(({ skill }) => skill?.name === name)?.skill?.body;
      const openui = await sourceAsset(
        'bundles/features/openui',
        'src/host/skills/openui.md',
      );
      const papercraft = await sourceAsset(
        'bundles/features/papercraft',
        'src/host/skills/papercraft.md',
      );

      assert.ok(openui.trim().length > 0);
      assert.equal(bodyOf('openui'), openui.trim());
      assert.ok(papercraft.trim().length > 0);
      assert.equal(bodyOf('papercraft'), papercraft.trim());
      // T7: the papercraft skill is registered with the tool it needs.
      assert.deepEqual(
        [
          ...(skills.find(({ skill }) => skill?.name === 'papercraft')?.skill
            ?.allowedTools ?? []),
        ],
        ['comment_reply'],
      );
      assert.ok((await listedTools(host)).includes('comment_reply'));

      const agents = host.platform.client(
        await stagedService('default', 'doric.default.agents.v1.AgentsService'),
      ) as unknown as {
        list(request: object): Promise<{
          readonly agents: readonly { readonly name: string }[];
        }>;
        resolve(request: { name: string }): Promise<{
          readonly agentDefinition?: {
            readonly description: string;
            readonly instructions: string;
          };
        }>;
      };
      // The built-ins, in shipped order (no Thread, so no workspace agents).
      assert.deepEqual(
        (await agents.list({})).agents.map(({ name }) => name),
        [
          'triage',
          'search',
          'spec',
          'review',
          'plan',
          'contracts',
          'tests',
          'implementation',
          'cleanup',
          'docs',
        ],
      );

      const file = await sourceAsset(
        'bundles/runtime/default',
        'src/host/agents/tests.md',
      );
      const { agentDefinition } = await agents.resolve({ name: 'tests' });
      assert.ok(agentDefinition);
      assert.equal(agentDefinition.description, descriptionOf(file));
      assert.ok(agentDefinition.instructions.trim().length > 0);
      assert.ok(file.includes(agentDefinition.instructions.trim()));
    });
  },
);
