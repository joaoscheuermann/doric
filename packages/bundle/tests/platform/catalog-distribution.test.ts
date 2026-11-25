// What the platform serves the desktop of `doric.catalog/v1` (groupE S63a;
// spec `docs/designs/grpc-processes.md`, section 13 "Desktop", HR-2..HR-6):
// `Distribution`, `ReadArtifact`, `Watch`, and the recovery actions
// `Disable` and `ResetComposition`, called as the desktop calls them, through
// the public listener over the Connect protocol in binary, without
// `doric-client-part`. Each bundle is a process of the fixture
// `tests/fixtures/scripted`; its staged directory is a temporary one
// (`tests/support/staged-dirs.ts`).

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { describe, type TestContext } from 'node:test';

import { type DescService, toJson } from '@bufbuild/protobuf';
import {
  type Client,
  Code,
  ConnectError,
  createClient,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

import {
  CatalogService,
  type CatalogSnapshot,
  CatalogSnapshotSchema,
} from '../../src/contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import { fromConnectError } from '../../src/contracts/status.js';
import { distributionFiles } from '../../src/loader/distribution.js';
import { readCompositionOverrides } from '../../src/loader/overrides.js';
import type { Platform } from '../../src/platform/index.js';
import type { ResolvedEnvironment } from '../../src/runtime/index.js';
import {
  type FixtureBundle,
  isAlive,
  type PlatformHost,
  type PlatformSetupOptions,
  resolveHost,
  setupPlatform,
  sleep,
  until,
  within,
} from '../support/scripted-host.js';
import {
  bigBytes,
  compositionOptions,
  maxChunkBytes,
  type StagedDirs,
  sha256Of,
  stagedDirs,
  stagedFiles,
} from '../support/staged-dirs.js';

// ---------------------------------------------------------------------------
// Helpers

const alive: FixtureBundle = { mode: 'alive' };

/** A bundle that crashes 50 ms after each activation: quarantined soon. */
const crashing: FixtureBundle = { mode: 'crash-after-active', ms: 50 };

/**
 * A bundle that crashes once, 400 ms after its first activation: after the
 * test opened its `Watch`.
 */
const crashingOnce: FixtureBundle = {
  mode: 'crash-after-active',
  ms: 400,
  count: 1,
};

interface Host extends PlatformHost {
  readonly dirs: StagedDirs;
  /** A Connect binary client of `service` on the public port. */
  client<S extends DescService>(service: S): Client<S>;
  /** `resolveHost(bundles)` in the staged directories, as `generation`. */
  resolution(
    bundles: Readonly<Record<string, FixtureBundle>>,
    generation: number,
  ): ResolvedEnvironment;
}

/**
 * Boots `core` and `bundles`, each with a staged directory (and `extra`'s,
 * for the publishes that add it), with a public listener on `127.0.0.1:0`.
 */
const boot = async (
  t: TestContext,
  bundles: Readonly<Record<string, FixtureBundle>>,
  options: PlatformSetupOptions & { readonly recovery?: boolean } = {},
): Promise<Host> => {
  const dirs = stagedDirs(t);
  const { recovery, ...setup } = options;

  dirs.stage('core', 'extra', ...Object.keys(bundles));

  const env = await setupPlatform(t, bundles, {
    ...setup,
    publicAddress: '127.0.0.1:0',
    dirOf: dirs.dirOf,
    ...(recovery === true
      ? { composition: compositionOptions(dirs.root, bundles, dirs.dirOf) }
      : {}),
  });

  return {
    ...env,
    dirs,
    client: (service) => connectOf(env.platform, service),
    resolution: (next, generation) => ({
      ...resolveHost(next, { dirOf: dirs.dirOf }),
      generation,
    }),
  };
};

const connectOf = <S extends DescService>(
  platform: Platform,
  service: S,
): Client<S> => {
  const port = platform.publicPort;

  assert.equal(typeof port, 'number', 'the platform has a public port');

  return createClient(
    service,
    createConnectTransport({
      baseUrl: `http://127.0.0.1:${port}`,
      httpVersion: '1.1',
      useBinaryFormat: true,
    }),
  );
};

/** The `ConnectError` `promise` rejects with; fails the test when it resolves. */
const failureOf = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await within(promise, 'the call', 6_000);
  } catch (error) {
    assert.ok(
      error instanceof ConnectError,
      `expected a ConnectError: ${error}`,
    );

    return error;
  }

  return assert.fail('the call succeeded');
};

const assertFailure = (error: ConnectError, grpc: Code, code: string): void => {
  assert.equal(fromConnectError(error).code, code, error.message);
  assert.equal(error.code, grpc, error.message);
};

/** `Get`'s snapshot. */
const getOf = async (
  client: Client<typeof CatalogService>,
): Promise<CatalogSnapshot> => {
  const { catalogSnapshot } = await within(client.get({}), 'Get');

  assert.ok(catalogSnapshot !== undefined, 'Get answered no snapshot');

  return catalogSnapshot;
};

/** A snapshot message as JSON, to compare two of them. */
const jsonOf = (snapshot: CatalogSnapshot | undefined) =>
  snapshot === undefined ? undefined : toJson(CatalogSnapshotSchema, snapshot);

const stateIn = (
  snapshot: CatalogSnapshot | undefined,
  id: string,
): string | undefined =>
  snapshot?.bundles.find((bundle) => bundle.id === id)?.state;

/** The chunks of one `ReadArtifact` read, or the error that ended it. */
const readArtifact = async (
  client: Client<typeof CatalogService>,
  sha256: string,
): Promise<readonly Uint8Array[]> => {
  const chunks: Uint8Array[] = [];

  await within(
    (async () => {
      for await (const { chunk } of client.readArtifact({ sha256 })) {
        chunks.push(chunk);
      }
    })(),
    'ReadArtifact',
    6_000,
  );

  return chunks;
};

/** An open `Watch`: the items so far, and the error that ended it, if any. */
interface Watching {
  readonly items: CatalogSnapshot[];
  error(): unknown;
  /** Waits for `count` items; fails with the stream's error if it ended. */
  until(count: number, what: string): Promise<void>;
}

const watch = (
  t: TestContext,
  client: Client<typeof CatalogService>,
): Watching => {
  const controller = new AbortController();
  const items: CatalogSnapshot[] = [];
  let failure: unknown;
  const reading = (async () => {
    try {
      for await (const { catalogSnapshot } of client.watch(
        {},
        { signal: controller.signal },
      )) {
        assert.ok(
          catalogSnapshot !== undefined,
          'a Watch item without snapshot',
        );
        items.push(catalogSnapshot);
      }
    } catch (error) {
      failure ??= error;
    }
  })();

  t.after(async () => {
    controller.abort();
    await reading;
  });

  return {
    items,
    error: () => failure,
    until: async (count, what) => {
      await until(
        () => items.length >= count || failure !== undefined,
        what,
        8_000,
      );

      if (items.length < count) {
        assert.fail(`Watch ended after ${items.length} items: ${failure}`);
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Distribution

describe('doric.catalog/v1 Distribution through the public listener', () => {
  test('answers a non-empty hostBoot, the same on two calls, a host equal to Get, and per bundle the files distributionFiles lists for its staged directory', async (t) => {
    const env = await boot(t, { app: alive });
    const catalog = env.client(CatalogService);
    const first = await within(catalog.distribution({}), 'Distribution');
    const second = await within(catalog.distribution({}), 'Distribution');
    const host = await getOf(catalog);

    assert.notEqual(first.hostBoot, '');
    assert.equal(second.hostBoot, first.hostBoot);
    assert.deepEqual(jsonOf(first.host), jsonOf(host));
    assert.deepEqual(
      first.bundles.map(({ id }) => id),
      host.bundles.map(({ id }) => id),
    );

    for (const bundle of first.bundles) {
      assert.deepEqual(
        bundle.files.map(({ path, sha256, size }) => ({ path, sha256, size })),
        await distributionFiles(env.dirs.dirOf(bundle.id)),
        `the files of ${bundle.id}`,
      );
    }
  });

  test('after a bundle is quarantined, the next answer shows it quarantined with the same files', async (t) => {
    const env = await boot(t, { app: alive, crashy: crashing });
    const catalog = env.client(CatalogService);
    const before = await within(catalog.distribution({}), 'Distribution');
    const filesOf = (answer: typeof before) =>
      answer.bundles
        .find(({ id }) => id === 'crashy')
        ?.files.map(({ path, sha256, size }) => ({ path, sha256, size }));

    await until(
      () => env.diagnostics.state('crashy') === 'quarantined',
      'crashy to be quarantined',
      10_000,
    );

    const after = await within(catalog.distribution({}), 'Distribution');
    const crashy = after.bundles.find(({ id }) => id === 'crashy');

    assert.equal(crashy?.state, 'quarantined');
    assert.ok(
      crashy?.reasons.some(({ code }) => code === 'process_failed'),
      `crashy's reasons: ${JSON.stringify(crashy?.reasons)}`,
    );
    assert.deepEqual(filesOf(after), filesOf(before));
    assert.deepEqual(
      filesOf(after),
      await distributionFiles(env.dirs.dirOf('crashy')),
    );
  });
});

// ---------------------------------------------------------------------------
// ReadArtifact

describe('doric.catalog/v1 ReadArtifact through the public listener', () => {
  test('the concatenated chunks of a listed file equal its bytes', async (t) => {
    const env = await boot(t, { app: alive });
    const bytes = stagedFiles('app')['client/index.js'] as Buffer;
    const chunks = await readArtifact(
      env.client(CatalogService),
      sha256Of(bytes),
    );

    assert.deepEqual(Buffer.concat(chunks), bytes);
  });

  test('a 2.5 MiB file arrives in 3 chunks of at most 1 MiB', async (t) => {
    const env = await boot(t, { app: alive });
    const bytes = bigBytes();
    const chunks = await readArtifact(
      env.client(CatalogService),
      sha256Of(bytes),
    );

    assert.equal(chunks.length, 3);

    for (const chunk of chunks) {
      assert.ok(chunk.length <= maxChunkBytes, `a chunk of ${chunk.length}`);
    }

    assert.ok(Buffer.concat(chunks).equals(bytes), 'the bytes differ');
  });

  test('an empty file is a stream without items', async (t) => {
    const env = await boot(t, { app: alive });
    const chunks = await readArtifact(
      env.client(CatalogService),
      sha256Of(Buffer.alloc(0)),
    );

    assert.deepEqual(chunks, []);
  });

  test('an unlisted SHA-256 answers NOT_FOUND not_found; "xyz" answers INVALID_ARGUMENT', async (t) => {
    const env = await boot(t, { app: alive });
    const catalog = env.client(CatalogService);

    assertFailure(
      await failureOf(readArtifact(catalog, sha256Of('no staged file'))),
      Code.NotFound,
      'not_found',
    );
    assertFailure(
      await failureOf(readArtifact(catalog, 'xyz')),
      Code.InvalidArgument,
      'invalid_input',
    );
  });

  test('a listed file changed on disk answers NOT_FOUND', async (t) => {
    const env = await boot(t, { app: alive });
    const catalog = env.client(CatalogService);
    const bytes = stagedFiles('app')['client/index.js'] as Buffer;

    // Listed by the boot's resolution: readable as staged.
    assert.deepEqual(
      Buffer.concat(await readArtifact(catalog, sha256Of(bytes))),
      bytes,
    );

    writeFileSync(
      join(env.dirs.dirOf('app'), 'client', 'index.js'),
      "export const client = 'changed';\n",
    );

    assertFailure(
      await failureOf(readArtifact(catalog, sha256Of(bytes))),
      Code.NotFound,
      'not_found',
    );
  });
});

// ---------------------------------------------------------------------------
// Watch

describe('doric.catalog/v1 Watch through the public listener', () => {
  test('the first item equals Get', async (t) => {
    const env = await boot(t, { app: alive });
    const catalog = env.client(CatalogService);
    const watching = watch(t, catalog);

    await watching.until(1, 'the first Watch item');

    assert.deepEqual(jsonOf(watching.items[0]), jsonOf(await getOf(catalog)));
  });

  test('a publish that adds a bundle sends one item with the next generation listing it; once active, Get shows it active', async (t) => {
    const env = await boot(t, { app: alive });
    const catalog = env.client(CatalogService);
    const watching = watch(t, catalog);

    await watching.until(1, 'the first Watch item');

    const result = await within(
      env.platform.publish(env.resolution({ app: alive, extra: alive }, 2)),
      'the publish',
      10_000,
    );

    assert.equal(result.status, 'published');
    await watching.until(2, 'the item of the publish');
    await sleep(300);

    assert.equal(watching.items.length, 2);

    const item = watching.items[1];

    assert.equal(item?.generation, 2);
    assert.ok(
      item?.bundles.some(({ id }) => id === 'extra'),
      `the item lists ${item?.bundles.map(({ id }) => id)}`,
    );
    // The state comes from the diagnostics, which follow the publish (Q9).
    assert.equal(stateIn(await getOf(catalog), 'extra'), 'active');
  });

  test('a crash restart sends no item', async (t) => {
    const env = await boot(t, { app: alive, crashy: crashingOnce });
    const watching = watch(t, env.client(CatalogService));

    await watching.until(1, 'the first Watch item');
    await until(
      () => env.log.countOf('crashy', 'activated') === 2,
      'crashy to be active again after its crash',
      8_000,
    );
    await sleep(300);

    assert.equal(watching.items.length, 1);
    assert.equal(watching.error(), undefined);
  });

  test('the stream survives a restart of every bundle', async (t) => {
    const env = await boot(
      t,
      { app: crashingOnce },
      { scripts: { core: crashingOnce } },
    );
    const watching = watch(t, env.client(CatalogService));

    await watching.until(1, 'the first Watch item');
    await until(
      () =>
        env.log.countOf('core', 'activated') === 2 &&
        env.log.countOf('app', 'activated') === 2,
      'core and app to be active again after their crash',
      8_000,
    );

    const result = await within(
      env.platform.publish(
        env.resolution({ app: crashingOnce, extra: alive }, 2),
      ),
      'the publish',
      10_000,
    );

    assert.equal(result.status, 'published');
    await watching.until(2, 'the item of the publish');

    assert.equal(watching.error(), undefined);
    assert.equal(watching.items[1]?.generation, 2);
  });
});

// ---------------------------------------------------------------------------
// Disable and ResetComposition

describe('doric.catalog/v1 Disable and ResetComposition through the public listener', () => {
  test('without PlatformOptions.composition, both answer UNIMPLEMENTED unknown_contract', async (t) => {
    const env = await boot(t, { app: alive });
    const catalog = env.client(CatalogService);

    assertFailure(
      await failureOf(catalog.disable({ bundleId: 'app' })),
      Code.Unimplemented,
      'unknown_contract',
    );
    assertFailure(
      await failureOf(catalog.resetComposition({})),
      Code.Unimplemented,
      'unknown_contract',
    );
  });

  test('Disable of a bundle writes the overrides, Get shows it disabled, its process is gone, and Watch sent an item', async (t) => {
    const env = await boot(t, { app: alive, extra: alive }, { recovery: true });
    const catalog = env.client(CatalogService);
    const watching = watch(t, catalog);

    await watching.until(1, 'the first Watch item');
    await within(catalog.disable({ bundleId: 'extra' }), 'Disable', 10_000);

    assert.deepEqual(
      await readCompositionOverrides(
        join(env.dirs.root, 'composition.overrides.json'),
      ),
      { disabled: ['extra'] },
    );
    assert.equal(stateIn(await getOf(catalog), 'extra'), 'disabled');
    await until(
      () => env.log.pidsOf('extra').every((pid) => !isAlive(pid)),
      "extra's process to end",
      8_000,
    );
    await watching.until(2, 'the item of the publish');
    assert.equal(stateIn(watching.items[1], 'extra'), 'disabled');
  });

  test('Disable of the core answers INVALID_ARGUMENT invalid_input; of an unknown bundle, NOT_FOUND not_found', async (t) => {
    const env = await boot(t, { app: alive }, { recovery: true });
    const catalog = env.client(CatalogService);

    assertFailure(
      await failureOf(catalog.disable({ bundleId: 'core' })),
      Code.InvalidArgument,
      'invalid_input',
    );
    assertFailure(
      await failureOf(catalog.disable({ bundleId: 'ghost' })),
      Code.NotFound,
      'not_found',
    );
    assert.equal(
      existsSync(join(env.dirs.root, 'composition.overrides.json')),
      false,
    );
  });

  test('a resolution with a changed core answers UNAVAILABLE unavailable, status kernel_restart_required, and keeps the overrides', async (t) => {
    const env = await boot(t, { app: alive, extra: alive }, { recovery: true });
    const catalog = env.client(CatalogService);

    // The core's executable changed: the next resolution's core differs.
    env.digests.set('core', 'v2');

    const error = await failureOf(catalog.disable({ bundleId: 'extra' }));

    assertFailure(error, Code.Unavailable, 'unavailable');
    assert.deepEqual(fromConnectError(error).details, {
      status: 'kernel_restart_required',
    });
    assert.deepEqual(
      await readCompositionOverrides(
        join(env.dirs.root, 'composition.overrides.json'),
      ),
      { disabled: ['extra'] },
    );
  });

  test('two concurrent Disables both land in the overrides', async (t) => {
    const env = await boot(
      t,
      { app: alive, extra: alive, other: alive },
      { recovery: true },
    );
    const catalog = env.client(CatalogService);

    await within(
      Promise.all([
        catalog.disable({ bundleId: 'extra' }),
        catalog.disable({ bundleId: 'other' }),
      ]),
      'both Disables',
      15_000,
    );

    const overrides = await readCompositionOverrides(
      join(env.dirs.root, 'composition.overrides.json'),
    );

    assert.deepEqual([...(overrides?.disabled ?? [])].sort(), [
      'extra',
      'other',
    ]);
  });

  test('ResetComposition removes the overrides and the disabled bundle is active again', async (t) => {
    const env = await boot(t, { app: alive, extra: alive }, { recovery: true });
    const catalog = env.client(CatalogService);
    const overridesPath = join(env.dirs.root, 'composition.overrides.json');

    await within(catalog.disable({ bundleId: 'extra' }), 'Disable', 10_000);
    assert.equal(stateIn(await getOf(catalog), 'extra'), 'disabled');

    await within(catalog.resetComposition({}), 'ResetComposition', 10_000);

    assert.equal(existsSync(overridesPath), false);
    assert.equal(stateIn(await getOf(catalog), 'extra'), 'active');
  });
});
