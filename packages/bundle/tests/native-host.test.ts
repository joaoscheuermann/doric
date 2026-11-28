// Native host parts (spec `docs/designs/grpc-processes.md`, section 14 "Rust",
// A30; slice S75a, "S75's plan"): what a native part provides
// (`nativeProvides`), its build without esbuild, and its staging from the
// Cargo target directory; and (slice S75b, T4.22) the staged `sqlite` bundle
// on the platform.

import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { file_doric_models_provider_v1_provider } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import { file_doric_platform_app_hooks_v1_hooks } from 'bundle/contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { file_doric_platform_log_v1_log } from 'bundle/contracts/gen/doric/platform/log/v1/log_pb.js';
import {
  Cardinality,
  Environment,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';
import {
  file_doric_storage_kv_v1_kv,
  KvService,
} from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';
import { file_doric_ui_v1_ui } from 'bundle/contracts/gen/doric/ui/v1/ui_pb.js';

import { nativeProvides } from '../src/build/host-provides.js';
import {
  BuildError,
  buildBundle,
  discoverBundles,
  stageBundles,
} from '../src/index.js';
import {
  createCatalogIndex,
  readStagedCatalogIndex,
  stagedCommandOf,
  startPlatform,
  withBasicContracts,
} from '../src/platform/index.js';
import {
  type CatalogCandidate,
  DiagnosticsStore,
  type Manifest,
  parseManifest,
  resolveEnvironment,
} from '../src/runtime/index.js';
import {
  contractProto,
  demoProto,
  descFileOf,
} from './support/descriptor-sets.js';
import { withRoot, writeBundle } from './support/fixtures.js';
import {
  commandsOf,
  coreCandidate,
  fixtureLog,
  testTimings,
  within,
} from './support/scripted-host.js';

const exists = async (path: string) => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

/** A v2 manifest of the host part `engine` of `kind` that lists `provides`. */
const nativeManifest = (
  provides: readonly string[] = [],
  kind: 'native' | 'sea' = 'native',
) => ({
  manifestVersion: 2,
  id: 'engine',
  version: '1.0.0',
  engines: { doric: '^1.0.0' },
  provides: [...provides],
  host: { kind },
});

// nativeProvides --------------------------------------------------------------

/** A HOST contract file whose only service is a handler service. */
const handlerOnlyFile = () => {
  const proto = contractProto({
    name: 'demo/handler/v1/handler.proto',
    package: 'demo.handler.v1',
    contract: {
      id: 'demo.handler/v1',
      cardinality: Cardinality.ONE,
      environment: Environment.HOST,
    },
  });

  proto.service = proto.service.filter(({ name }) => name !== 'DemoService');

  return descFileOf(proto);
};

/** A HOST contract file that declares no service. */
const serviceFreeFile = () => {
  const proto = contractProto({
    name: 'demo/empty/v1/empty.proto',
    package: 'demo.empty.v1',
    contract: {
      id: 'demo.empty/v1',
      cardinality: Cardinality.MANY,
      environment: Environment.HOST,
    },
  });

  proto.service = [];

  return descFileOf(proto);
};

const index = createCatalogIndex([
  file_doric_storage_kv_v1_kv,
  file_doric_models_provider_v1_provider,
  file_doric_ui_v1_ui,
  file_doric_platform_log_v1_log,
  file_doric_platform_app_hooks_v1_hooks,
  descFileOf(demoProto()),
  handlerOnlyFile(),
  serviceFreeFile(),
]);

/**
 * The parsed native manifest with `provides` set as given, unchecked, so a
 * duplicate or a malformed entry reaches `nativeProvides` as it is.
 */
const listing = (provides: readonly string[]): Manifest =>
  ({
    ...parseManifest(nativeManifest()).manifest,
    provides: [...provides],
  }) as Manifest;

const kv = {
  id: 'storage.kv/v1',
  kind: 'service',
  cardinality: 'one',
  source: 'doric/storage/kv/v1/kv.proto',
  declared: '1.0.0',
} as const;

void test('nativeProvides answers storage.kv/v1 as a service with its cardinality, its .proto and the listed version', () => {
  assert.deepEqual(
    nativeProvides({ manifest: listing(['storage.kv/v1@1.0.0']), index }),
    [kv],
  );
});

void test('nativeProvides keeps the order of provides, takes each .proto cardinality, and keeps the first of a duplicate', () => {
  assert.deepEqual(
    nativeProvides({
      manifest: listing([
        'models.provider/v1@1.2.0',
        'storage.kv/v1@1.0.0',
        'demo.api/v1@1.1.0',
        'storage.kv/v1@1.3.0',
        'models.provider/v1@1.4.0',
      ]),
      index,
    }),
    [
      {
        id: 'models.provider/v1',
        kind: 'service',
        cardinality: 'many',
        source: 'doric/models/provider/v1/provider.proto',
        declared: '1.2.0',
      },
      kv,
      {
        id: 'demo.api/v1',
        kind: 'service',
        cardinality: 'one',
        source: 'demo/v1/demo.proto',
        declared: '1.1.0',
      },
    ],
  );
});

void test('nativeProvides leaves out unknown ids, other environments, files without a contract service and unparsable entries', () => {
  assert.deepEqual(
    nativeProvides({
      manifest: listing([
        'nothing/v1@1.0.0',
        'ui/v1@1.0.0',
        'doric.log/v1@1.0.0',
        'doric.app.hooks/v1@1.0.0',
        'demo.handler/v1@1.0.0',
        'demo.empty/v1@1.0.0',
        'not an entry',
        'storage.kv/v1',
        'storage.kv/v1@1.0.0',
      ]),
      index,
    }),
    [kv],
  );
});

void test('nativeProvides never throws: no provides, or an index that knows none of them, answers []', () => {
  assert.deepEqual(nativeProvides({ manifest: listing([]), index }), []);
  assert.deepEqual(
    nativeProvides({
      manifest: listing(['storage.kv/v1@1.0.0', '', '@', 'x/v1@']),
      index: createCatalogIndex([]),
    }),
    [],
  );
});

// buildBundle -----------------------------------------------------------------

const mainMjs = (dir: string) => join(dir, 'dist', 'host', 'main.mjs');

void test('a native bundle that lists storage.kv/v1 builds without esbuild: no dist/host/main.mjs, and the contract on host', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'engine', {
      manifest: nativeManifest(['storage.kv/v1@1.0.0']),
    });
    const { descriptor } = await buildBundle(dir);

    assert.equal(await exists(join(dir, 'dist', 'manifest.json')), true);
    assert.equal(await exists(mainMjs(dir)), false);

    const entry = descriptor.contracts.find(({ id }) => id === 'storage.kv/v1');

    assert.deepEqual(
      entry === undefined
        ? undefined
        : {
            version: entry.version,
            kind: entry.kind,
            environment: entry.environment,
            cardinality: entry.cardinality,
          },
      {
        version: '1.0.0',
        kind: 'service',
        environment: 'host',
        cardinality: 'one',
      },
    );
  });
});

void test('a native bundle with a src/host/main.ts rejects with a BuildError and writes no main.mjs', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'engine', {
      manifest: nativeManifest(),
      files: { 'src/host/main.ts': "console.log('host');\n" },
    });

    await assert.rejects(buildBundle(dir), (error: unknown) => {
      assert.ok(error instanceof BuildError, String(error));
      assert.equal(
        error.message,
        'A native host part has no src/host/main.ts.',
      );

      return true;
    });
    assert.equal(await exists(mainMjs(dir)), false);
  });
});

void test('a sea bundle that lists storage.kv/v1 and serves nothing still fails with "provides declares" (guard)', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'engine', {
      manifest: nativeManifest(['storage.kv/v1@1.0.0'], 'sea'),
    });

    await assert.rejects(buildBundle(dir), (error: unknown) => {
      assert.ok(error instanceof BuildError, String(error));
      assert.ok(
        error.message.includes(
          'provides declares storage.kv/v1, but no part provides, defines or registers it during activate.',
        ),
        error.message,
      );

      return true;
    });
  });
});

// stageBundles ----------------------------------------------------------------

/**
 * The bundle `<root>/engine` already built: its `dist/manifest.json` is
 * written directly, so staging is observed independently of the build.
 */
const writeBuiltNative = (root: string) =>
  writeBundle(root, 'engine', {
    manifest: nativeManifest(['storage.kv/v1@1.0.0']),
    files: {
      'dist/manifest.json': JSON.stringify(
        nativeManifest(['storage.kv/v1@1.0.0']),
      ),
    },
  });

const executable = (targetDir: string, profile: 'debug' | 'release') =>
  join(targetDir, 'doric-engine', profile, 'doric-engine');

/** Writes a fake cargo output at `path`, not executable by its group or others. */
const writeExecutable = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o700 });
};

const stagedHost = (destination: string) => join(destination, 'engine', 'host');

const readCommand = async (destination: string) =>
  JSON.parse(
    await readFile(join(stagedHost(destination), 'command.json'), 'utf8'),
  ) as unknown;

void test('dev staging of a native part writes host/command.json running the debug executable and copies none', async () => {
  await withRoot(async (root) => {
    const dir = await writeBuiltNative(root);
    const targetDir = join(root, 'target');
    const destination = join(root, 'staged');

    await writeExecutable(executable(targetDir, 'debug'), 'debug build\n');
    await stageBundles(destination, [dir], { dev: true, targetDir });

    assert.equal(
      await exists(join(stagedHost(destination), 'command.json')),
      true,
      'host/command.json is written',
    );
    assert.deepEqual(await readCommand(destination), [
      executable(targetDir, 'debug'),
    ]);
    assert.equal(
      await exists(join(stagedHost(destination), 'doric-engine')),
      false,
    );
  });
});

void test('dev staging of a native part reads the executable below dist/target of the working directory by default', async () => {
  await withRoot(async (temporary) => {
    const root = await realpath(temporary);
    const dir = await writeBuiltNative(root);
    const targetDir = join(root, 'dist', 'target');
    const destination = join(root, 'staged');
    const previous = process.cwd();

    await writeExecutable(executable(targetDir, 'debug'), 'debug build\n');
    process.chdir(root);

    try {
      await stageBundles(destination, [dir], { dev: true });
    } finally {
      process.chdir(previous);
    }

    assert.equal(
      await exists(join(stagedHost(destination), 'command.json')),
      true,
      'host/command.json is written',
    );
    assert.deepEqual(await readCommand(destination), [
      executable(targetDir, 'debug'),
    ]);
  });
});

void test('release staging of a native part copies the release executable to host/doric-<id> with mode 0755 and the same bytes', async () => {
  await withRoot(async (root) => {
    const dir = await writeBuiltNative(root);
    const targetDir = join(root, 'target');
    const destination = join(root, 'staged');
    const release = executable(targetDir, 'release');
    const staged = join(stagedHost(destination), 'doric-engine');

    await writeExecutable(executable(targetDir, 'debug'), 'debug build\n');
    await writeExecutable(release, '\u007fELF release build\n');
    await stageBundles(destination, [dir], { targetDir });

    assert.equal(await exists(staged), true, 'host/doric-engine is copied');
    assert.equal((await stat(staged)).mode & 0o777, 0o755);
    assert.deepEqual(await readFile(staged), await readFile(release));
    assert.equal(
      await exists(join(stagedHost(destination), 'command.json')),
      false,
    );
  });
});

const rejectsWith = (promise: Promise<unknown>, message: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BuildError, String(error));
    assert.equal(error.message, message);

    return true;
  });

void test('staging a native part whose executable is missing rejects naming it and the compile target', async () => {
  await withRoot(async (root) => {
    const dir = await writeBuiltNative(root);
    const targetDir = join(root, 'target');
    const destination = join(root, 'staged');

    await rejectsWith(
      stageBundles(destination, [dir], { dev: true, targetDir }),
      `engine: ${executable(targetDir, 'debug')} is missing; run npx nx run engine:compile`,
    );

    // A debug build alone does not stage a release.
    await writeExecutable(executable(targetDir, 'debug'), 'debug build\n');
    await rejectsWith(
      stageBundles(destination, [dir], { targetDir }),
      `engine: ${executable(targetDir, 'release')} is missing; run npx nx run engine:compile:production`,
    );
  });
});

// platform (S75b) -------------------------------------------------------------

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** The staged bundle `id` of `bundlesDir` as a catalog candidate. */
const stagedCandidate = async (
  bundlesDir: string,
  id: string,
): Promise<CatalogCandidate> => {
  const bundle = (await discoverBundles(bundlesDir)).find(
    ({ read }) => read?.manifest.id === id,
  );

  assert.ok(bundle !== undefined, `${id} is staged in ${bundlesDir}`);

  return {
    id,
    source: { kind: 'installed', dir: bundle.dir },
    ...(bundle.read === undefined ? {} : { manifest: bundle.read.manifest }),
    ...(bundle.descriptor === undefined
      ? {}
      : { descriptor: bundle.descriptor }),
    errors: bundle.errors,
  };
};

void test('T4.22: the staged sqlite bundle runs on the platform beside core and serves a committed put through storage.kv/v1 in DORIC_STORAGE_PATH', async (t) => {
  const staging = await mkdtemp(join(tmpdir(), 'doric-s75b-staging-'));
  const storage = await mkdtemp(join(tmpdir(), 'doric-s75b-storage-'));

  t.after(async () => {
    await rm(staging, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  });

  await stageBundles(
    staging,
    [join(repositoryRoot, 'bundles/foundation/sqlite')],
    { dev: true, targetDir: join(repositoryRoot, 'dist/target') },
  );

  const sqlite = await stagedCandidate(staging, 'sqlite');
  const resolved = resolveEnvironment(
    {
      candidates: [coreCandidate(), sqlite],
      composition: { core: 'core', enabled: ['core', 'sqlite'], providers: {} },
      platformVersion: '1.0.0',
      generation: 1,
    },
    'host',
  );

  assert.deepEqual(
    ['core', 'sqlite'].map(
      (id) => resolved.entries.find((entry) => entry.id === id)?.state,
    ),
    ['scheduled', 'scheduled'],
    resolved.issues.join('\n'),
  );

  const diagnostics = new DiagnosticsStore({ generation: 1 });

  diagnostics.load(resolved);

  const log = fixtureLog(t);
  const key = new TextEncoder().encode('doric/t4.22');
  const value = new TextEncoder().encode('v');
  let position: number | undefined;
  const responses: { key: Uint8Array; value?: Uint8Array; version: number }[] =
    [];
  const platform = await within(
    startPlatform({
      index: withBasicContracts(
        await readStagedCatalogIndex(staging, ['sqlite']),
      ),
      resolved,
      commandOf: (id) =>
        id === 'sqlite'
          ? stagedCommandOf(staging)(id)
          : commandsOf({}, log)(id),
      env: { PATH: process.env.PATH, DORIC_STORAGE_PATH: storage },
      timings: testTimings,
      diagnostics,
      exit: () => {},
      writeLog: () => {},
      beforeListen: async (doric) => {
        const kv = doric.client(KvService);

        async function* items() {
          yield { item: { case: 'put' as const, value: { key, value } } };
        }

        ({ position } = await kv.commit(items()));

        for await (const response of kv.get({ keys: [key] })) {
          responses.push(response);
        }
      },
    }),
    'the platform to boot',
  );

  try {
    assert.ok(position !== undefined && position > 0, `position ${position}`);
    assert.equal(responses.length, 1);
    assert.deepEqual(responses[0]?.key, key);
    assert.equal(responses[0]?.version, position);
    assert.deepEqual(responses[0]?.value, value);
    assert.deepEqual(
      [diagnostics.state('core'), diagnostics.state('sqlite')],
      ['active', 'active'],
    );
    assert.equal(await exists(join(storage, 'doric.sqlite3')), true);
  } finally {
    await within(platform.shutdown(), 'the platform to shut down');
  }
});
