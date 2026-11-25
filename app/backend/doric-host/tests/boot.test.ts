import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  create,
  type DescMessage,
  type DescMethodServerStreaming,
  type DescMethodUnary,
  fromJson,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { CatalogService } from 'bundle/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';

import { ApiError, callApi, openStream } from './helpers/api.js';
import {
  freshDatabase,
  type LogLine,
  startHostProcess,
} from './helpers/host.js';
import {
  bundlePid,
  childProcesses,
  hostPartBundles,
  spawnedBundles,
} from './helpers/processes.js';

// The compiled host's boot and stop, observed as an operator sees them: the
// startup log, the fatal stage of a refused boot, the public API on the
// public listener, the bundle processes `ps` shows, and the exit code. Build
// doric first (the host stages its bundles with `stage --dev`).

/** The staged bundles the compiled host boots. */
const bundlesPath = 'app/backend/doric-host/dist/bundles';

/** The typeNames of the eight `doric.api.*` services `transport` serves. */
const apiServices = [
  'doric.api.config.v1.ConfigService',
  'doric.api.credentials.v1.CredentialsService',
  'doric.api.host.v1.HostService',
  'doric.api.projects.v1.ProjectsService',
  'doric.api.providers.v1.ProvidersService',
  'doric.api.status.v1.StatusService',
  'doric.api.terminals.v1.TerminalsService',
  'doric.api.threads.v1.ThreadsService',
];

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const databaseCase = connectionString === undefined;

const startup = (lines: readonly LogLine[]) =>
  lines.filter(({ component }) => component === 'startup');

/** The start-step lines each bundle logs from its `onHostStartHook`, in its order. */
const startSteps: Readonly<Record<string, readonly string[]>> = {
  postgres: ['Initializing PostgreSQL client', 'PostgreSQL client initialized'],
  core: ['Activating stored credentials'],
  'host-config': [
    'Activating Doric configuration',
    'Doric configuration activated',
  ],
  docker: ['Configuring sandbox pool', 'Sandbox pool configured'],
  runtime: [
    'Reconciling persisted projects and threads',
    'Workspace reconciled',
  ],
  transport: ['Network interfaces configured'],
};

/** The contract names (`name/vN`, no range) a staged manifest lists under `key`. */
const manifestContracts = async (
  bundle: string,
  key: 'provides' | 'requires',
): Promise<readonly string[]> => {
  const manifest = JSON.parse(
    await readFile(join(bundlesPath, bundle, 'manifest.json'), 'utf8'),
  ) as Record<string, readonly string[] | undefined>;

  return (manifest[key] ?? []).map((entry) => entry.split('@')[0] ?? entry);
};

/**
 * For each start-step bundle, the other start-step bundles providing a
 * contract it requires, read from the staged manifests: the activation order
 * puts each of them first.
 */
const startStepRequires = async (): Promise<
  ReadonlyMap<string, readonly string[]>
> => {
  const bundles = Object.keys(startSteps);
  const provides = new Map(
    await Promise.all(
      bundles.map(
        async (bundle) =>
          [bundle, await manifestContracts(bundle, 'provides')] as const,
      ),
    ),
  );

  return new Map(
    await Promise.all(
      bundles.map(async (bundle) => {
        const requires = await manifestContracts(bundle, 'requires');

        return [
          bundle,
          bundles.filter(
            (other) =>
              other !== bundle &&
              (provides.get(other) ?? []).some((id) => requires.includes(id)),
          ),
        ] as const;
      }),
    ),
  );
};

const fatalStage = (lines: readonly LogLine[]) =>
  lines.find(({ msg }) => msg === 'Doric failed to start')?.stage;

void test('boots through every startup stage in order and serves the public API', {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  try {
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      const lines = await host.lines();

      // Each bundle logs its own start step from its `onHostStartHook`, in
      // activation order (BWP-6): the transport names its public API, the
      // sandbox its pool, and the runtime its workspace. `Bundles loaded` comes
      // before the first start step, and `Binding HTTP listener` after the
      // last, just before the public listener binds.
      const messages = startup(lines).map(({ msg }) => msg ?? '');
      assert.deepEqual(messages.slice(0, 3), [
        'Doric starting',
        'Loading bundles',
        'Bundles loaded',
      ]);
      assert.deepEqual(messages.slice(-2), [
        'Binding HTTP listener',
        'Doric listening',
      ]);
      // The steps run one bundle at a time, each bundle's lines together and
      // in its order; which bundle goes first is the activation order's.
      const steps = messages.slice(3, -2);
      const bundleOf = (msg: string) =>
        Object.keys(startSteps).find((bundle) =>
          startSteps[bundle]?.includes(msg),
        );
      const order = [
        ...new Set(steps.map((msg) => bundleOf(msg) ?? `unexpected: ${msg}`)),
      ];
      assert.deepEqual([...order].sort(), Object.keys(startSteps).sort());
      assert.deepEqual(
        steps,
        order.flatMap((bundle) => startSteps[bundle] ?? []),
      );
      // A bundle's step comes after the steps of the bundles it requires
      // (the transport after the runtime, the runtime after the sandbox).
      const requires = await startStepRequires();
      assert.ok(requires.get('transport')?.includes('runtime'));
      for (const [bundle, required] of requires) {
        for (const dependency of required) {
          assert.ok(
            order.indexOf(dependency) < order.indexOf(bundle),
            `${bundle} starts after ${dependency}, which it requires: ${order.join(', ')}`,
          );
        }
      }
      const line = (msg: string) =>
        startup(lines).find((entry) => entry.msg === msg);

      assert.equal(line('Bundles loaded')?.bundleCount, 32);
      assert.equal(line('Bundles loaded')?.toolCount, 19);
      assert.equal(
        line('Sandbox pool configured')?.sandboxProviderName,
        'docker',
      );
      assert.equal(line('Sandbox pool configured')?.networkMode, 'egress');
      assert.equal(line('Sandbox pool configured')?.dockerSocketShared, false);
      // The public API replaces the Socket.IO namespaces.
      assert.deepEqual(
        [
          ...((line('Network interfaces configured')?.apiServices ??
            []) as string[]),
        ].sort(),
        apiServices,
      );
      assert.equal(
        line('Network interfaces configured')?.socketNamespaces,
        undefined,
      );
      assert.equal(line('Workspace reconciled')?.interruptedThreads, 0);
      assert.equal(line('Workspace reconciled')?.interruptedProjects, 0);
      // The chosen sandbox option is logged as the alternatives it belongs to.
      assert.deepEqual(line('Doric starting')?.alternatives, {
        sandbox: 'docker',
      });
      assert.deepEqual(line('Doric listening')?.alternatives, {
        sandbox: 'docker',
      });
      // The runtime process logs its own recovery steps through log/v1, in
      // their order. They reach the host log through the bundle's log stream,
      // which is not ordered against the host's own lines (they may land after
      // `Doric listening`), so wait a bounded time for all three.
      const recoverySteps = [
        'Project and thread reconciliation complete',
        'Interrupted prompts resumed',
        'Project sandbox recovery scheduled',
      ];
      const recoveryLines = (all: readonly LogLine[]) =>
        all.filter(({ msg }) => recoverySteps.includes(msg ?? ''));
      let logged = lines;
      for (
        const deadline = Date.now() + 5_000;
        recoveryLines(logged).length < recoverySteps.length &&
        Date.now() < deadline;
      ) {
        await delay(100);
        logged = await host.lines();
      }
      const recovery = recoveryLines(logged);
      assert.deepEqual(
        recovery.map(({ msg }) => msg),
        recoverySteps,
      );
      for (const entry of recovery) {
        assert.equal(entry.component, 'bundles', entry.msg);
        assert.equal(entry.bundleId, 'runtime', entry.msg);
      }
      // The host's own start step brackets the workspace it reconciled.
      assert.deepEqual(
        startup(logged)
          .map(({ msg }) => msg)
          .filter((msg) =>
            [
              'Reconciling persisted projects and threads',
              'Workspace reconciled',
            ].includes(msg ?? ''),
          ),
        ['Reconciling persisted projects and threads', 'Workspace reconciled'],
      );

      // The configuration the boot activated is the one the public API serves.
      const config = await callApi<{
        doricConfiguration?: { revision?: number };
      }>(host.url, 'doric.api.config.v1.ConfigService/GetConfig');
      assert.equal(
        config.doricConfiguration?.revision,
        line('Doric configuration activated')?.configRevision,
      );
      const projects = await callApi<{ items?: unknown[] }>(
        host.url,
        'doric.api.projects.v1.ProjectsService/ListProjects',
      );
      assert.deepEqual(projects.items ?? [], []);
      // No REST route is left on the public port.
      assert.equal((await host.request('/projects')).status, 404);
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

void test('a missing database URL fails the boot at database_client', {
  timeout: 120_000,
}, async () => {
  const host = await startHostProcess({});
  try {
    assert.equal(await host.exited, 1);
    const lines = await host.lines();
    // The storage identity is the boot's first read of the database.
    assert.equal(fatalStage(lines), 'database_client');
  } finally {
    await host.close();
  }
});

void test('legacy Project rows the stage-7 migration never moved fail the boot at database_client', {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString, {
    // Without stage 7 and the drop, the legacy tables stay and keep the row.
    skip: (migration) =>
      migration.endsWith('_runtime_documents') ||
      migration.endsWith('_drop_legacy_runtime_tables'),
  });
  try {
    await database.query(
      `INSERT INTO "project" ("id", "name", "state", "config_revision", "config_snapshot", "created_at", "updated_at")
       VALUES ($1, 'Legacy', 'READY', 1, '{}'::jsonb, now(), now())`,
      ['018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1600'],
    );
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      assert.equal(await host.exited, 1);
      assert.equal(fatalStage(await host.lines()), 'database_client');
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

void test('a composition without default fails the boot at bundle_load with Bundle recovery mode', {
  timeout: 120_000,
}, async () => {
  const directory = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'boot-'),
  );
  try {
    const composition = JSON.parse(
      await readFile('app/backend/doric-host/composition.json', 'utf8'),
    ) as { enabled: string[] };
    const path = resolve(directory, 'composition.json');
    await writeFile(
      path,
      JSON.stringify({
        ...composition,
        enabled: composition.enabled.filter((id) => id !== 'default'),
      }),
    );
    const host = await startHostProcess({
      DORIC_DATABASE_URL: 'postgresql://unused.invalid/doric',
      DORIC_COMPOSITION: path,
    });
    try {
      assert.equal(await host.exited, 1);
      const lines = await host.lines();
      assert.equal(fatalStage(lines), 'bundle_load');
      assert.ok(
        lines.some(
          ({ msg, reason }) =>
            msg === 'Bundle recovery mode' &&
            typeof reason === 'string' &&
            reason.includes('executor/v1'),
        ),
      );
    } finally {
      await host.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('SIGTERM runs the shutdown and exits 0 with no bundle process left', {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  try {
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      assert.ok(host.child.pid);
      const running = await childProcesses(host.child.pid);
      assert.ok(running.length > 0, 'the host runs its bundle processes');

      const started = Date.now();
      assert.equal(await host.stop(), 0);
      // Within the shutdown deadline, below compose's 30 s grace period.
      assert.ok(Date.now() - started < 30_000);
      // Every instance was stopped (or killed at the deadline) before the exit.
      const alive = (
        await Promise.all(
          running.map(async ({ pid }) => {
            try {
              process.kill(pid, 0);
              return [pid];
            } catch {
              return [];
            }
          }),
        )
      ).flat();
      assert.deepEqual(alive, []);
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

void test('ps shows one process per scheduled host part and none for a client-only bundle', {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  try {
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      assert.ok(host.child.pid);
      const spawned = await spawnedBundles(
        bundlesPath,
        await childProcesses(host.child.pid),
      );

      // AC3.1, D-4: one process per host part, the alternative not chosen
      // (`firecracker`) and the client-only bundles none.
      assert.deepEqual([...spawned].sort(), hostPartBundles);
      assert.equal(await host.stop(), 0);
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

// `doric.catalog/v1` as the desktop reaches it on the booted host's public
// listener (groupE S63b): the distribution of the staged bundles, the bytes
// of a listed file, and the recovery actions over the composition's
// overrides. Calls go over the Connect protocol (JSON over HTTP/1.1, as
// `callApi` sends them), with the generated `CatalogService` descriptors and
// message schemas.

/** The procedure path of a generated method: `<package>.<Service>/<Method>`. */
const procedureOf = (method: {
  readonly name: string;
  readonly parent: { readonly typeName: string };
}): string => `${method.parent.typeName}/${method.name}`;

/** One unary call of a generated method on the public listener. */
const callMethod = async <I extends DescMessage, O extends DescMessage>(
  baseUrl: string,
  method: DescMethodUnary<I, O>,
  request: MessageInitShape<I>,
): Promise<MessageShape<O>> =>
  fromJson(
    method.output,
    await callApi<JsonValue>(
      baseUrl,
      procedureOf(method),
      toJson(method.input, create(method.input, request)),
    ),
  );

/** Every item of a server stream of a generated method, until its end. */
const streamMethod = async <I extends DescMessage, O extends DescMessage>(
  baseUrl: string,
  method: DescMethodServerStreaming<I, O>,
  request: MessageInitShape<I>,
): Promise<readonly MessageShape<O>[]> => {
  const procedure = procedureOf(method);
  const stream = await openStream<JsonValue>(
    baseUrl,
    procedure,
    toJson(method.input, create(method.input, request)),
  );
  const items: MessageShape<O>[] = [];

  try {
    for (;;) {
      let item: JsonValue;

      try {
        item = await stream.next();
      } catch (error) {
        // A stream that ends without an error ends the read.
        if (
          !(error instanceof ApiError) &&
          error instanceof Error &&
          error.message === `${procedure} ended`
        ) {
          return items;
        }
        throw error;
      }
      items.push(fromJson(method.output, item));
    }
  } finally {
    stream.close();
  }
};

/** The staged bundles: each directory of `bundlesPath` holding a `manifest.json`. */
const stagedBundles = async (): Promise<readonly string[]> => {
  const staged: string[] = [];

  for (const entry of await readdir(bundlesPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(bundlesPath, entry.name, 'manifest.json'));
      staged.push(entry.name);
    } catch {
      // Not a staged bundle.
    }
  }

  return staged.sort();
};

/** `Get`'s state of bundle `id`. */
const catalogState = async (
  baseUrl: string,
  id: string,
): Promise<string | undefined> =>
  (
    await callMethod(baseUrl, CatalogService.method.get, {})
  ).catalogSnapshot?.bundles.find((bundle) => bundle.id === id)?.state;

/**
 * The pid of the process running `bundleId` under `parent`, once `running`
 * holds for it (a pid when `true`, none when `false`), or what it is after
 * a bounded wait: a bundle process starts or stops shortly after the call
 * that changed the generation answered.
 */
const settledPid = async (
  parent: number,
  bundleId: string,
  running: boolean,
): Promise<number | undefined> => {
  let pid = await bundlePid(bundlesPath, parent, bundleId);

  for (
    const deadline = Date.now() + 15_000;
    (pid !== undefined) !== running && Date.now() < deadline;
  ) {
    await delay(200);
    pid = await bundlePid(bundlesPath, parent, bundleId);
  }

  return pid;
};

void test("Distribution on the public listener lists every staged bundle, and ReadArtifact answers the staged bytes of chat's client/index.js", {
  skip: databaseCase,
  timeout: 120_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  try {
    const host = await startHostProcess({ DORIC_DATABASE_URL: database.url });
    try {
      const distribution = await callMethod(
        host.url,
        CatalogService.method.distribution,
        {},
      );

      assert.deepEqual(
        distribution.bundles.map(({ id }) => id).sort(),
        await stagedBundles(),
      );

      const chat = distribution.bundles.find(({ id }) => id === 'chat');
      assert.ok(chat, 'chat is distributed');
      assert.equal(chat.parts?.client, 'client/index.js');
      const file = chat.files.find(({ path }) => path === 'client/index.js');
      assert.ok(file, 'chat lists client/index.js');

      const staged = await readFile(
        join(bundlesPath, 'chat', 'client', 'index.js'),
      );
      assert.equal(
        file.sha256,
        createHash('sha256').update(staged).digest('hex'),
      );
      assert.equal(file.size, staged.byteLength);

      const chunks = await streamMethod(
        host.url,
        CatalogService.method.readArtifact,
        { sha256: file.sha256 },
      );
      assert.deepEqual(Buffer.concat(chunks.map(({ chunk }) => chunk)), staged);
    } finally {
      await host.close();
    }
  } finally {
    await database.close();
  }
});

void test('Disable of usage writes composition.overrides.json and stops it, ResetComposition brings it back, and a boot over the overrides starts it disabled', {
  skip: databaseCase,
  timeout: 240_000,
}, async () => {
  assert.ok(connectionString);
  const database = await freshDatabase(connectionString);
  // The shipped composition, copied so its overrides are written beside the
  // copy and never beside `app/backend/doric-host/composition.json`.
  const directory = await mkdtemp(
    join('app/backend/doric-host/dist-tests', 'composition-'),
  );
  const compositionPath = resolve(directory, 'composition.json');
  const overridesPath = join(directory, 'composition.overrides.json');
  const environment = {
    DORIC_DATABASE_URL: database.url,
    DORIC_COMPOSITION: compositionPath,
  };

  try {
    await writeFile(
      compositionPath,
      await readFile('app/backend/doric-host/composition.json'),
    );

    const first = await startHostProcess(environment);
    try {
      assert.ok(first.child.pid);
      assert.equal(await catalogState(first.url, 'usage'), 'active');
      assert.ok(
        await settledPid(first.child.pid, 'usage', true),
        'usage runs before Disable',
      );

      await callMethod(first.url, CatalogService.method.disable, {
        bundleId: 'usage',
      });

      assert.deepEqual(
        (
          JSON.parse(await readFile(overridesPath, 'utf8')) as {
            disabled?: unknown;
          }
        ).disabled,
        ['usage'],
      );
      assert.equal(await catalogState(first.url, 'usage'), 'disabled');
      assert.equal(
        await settledPid(first.child.pid, 'usage', false),
        undefined,
        'no process runs usage after Disable',
      );
      assert.equal(await first.stop(), 0);
    } finally {
      await first.close();
    }

    // The overrides Disable wrote stay for the next boot.
    const second = await startHostProcess(environment);
    try {
      assert.ok(second.child.pid);
      assert.equal(await catalogState(second.url, 'usage'), 'disabled');
      assert.equal(
        await settledPid(second.child.pid, 'usage', false),
        undefined,
        'a boot over the overrides starts no usage process',
      );

      await callMethod(second.url, CatalogService.method.resetComposition, {});

      // The overrides are cleared: the file is gone or disables nothing.
      const cleared = await readFile(overridesPath, 'utf8').catch(
        (error: unknown) => {
          assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
          return undefined;
        },
      );
      assert.deepEqual(
        cleared === undefined
          ? []
          : ((JSON.parse(cleared) as { disabled?: unknown }).disabled ?? []),
        [],
      );
      assert.equal(await catalogState(second.url, 'usage'), 'active');
      assert.ok(
        await settledPid(second.child.pid, 'usage', true),
        'usage runs again after ResetComposition',
      );
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await database.close();
  }
});
