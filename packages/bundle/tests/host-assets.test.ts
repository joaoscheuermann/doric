// A host part's assets (spec `docs/designs/grpc-processes.md`, section 14,
// "Assets" (D35) and "Native code"; slice S32): `context.assets` reads the
// files the manifest's `host.assets` lists from the bundle directory, refuses
// any other path, answers the bundle directory from `extract`, and loads
// packages with native code through `require`. The spawned tests build a
// bundle whose `src/host/main.ts` calls `runBundle`, run its
// `dist/host/main.mjs` with `node` against a router listener, and read what
// its `activate` printed, one JSON line per call. The last test runs
// `startBundle` in this process without a bundle directory.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test, { before, describe, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { file_doric_tools_v1_tools } from '../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { buildBundle, type HostContext, startBundle } from '../src/index.js';
import { createCatalogIndex } from '../src/platform/catalog-index.js';
import {
  type InstanceKey,
  InstanceTable,
} from '../src/platform/router/instances.js';
import {
  type Router,
  startRouter,
} from '../src/platform/router/listener.js';
import { timings } from '../src/platform/supervisor/timings.js';
import { manifest, withRoot, writeBundle } from './support/fixtures.js';

// ---------------------------------------------------------------------------
// Helpers

/** The compiled host SDK the fixture bundles import (esbuild bundles it in). */
const sdk = fileURLToPath(new URL('../src/sdk/host/index.js', import.meta.url));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves with `promise`'s value; fails the test after `timeoutMs`. */
const within = async <T>(
  promise: Promise<T>,
  what: string,
  timeoutMs = 5_000,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${what}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** Polls `predicate` until it holds; fails after `timeoutMs`. */
const until = async (
  predicate: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;

  while (!predicate()) {
    if (performance.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await sleep(5);
  }
};

/** Starts a router listener; closed by the returned function. */
const startTestRouter = async (): Promise<{
  readonly router: Router;
  readonly table: InstanceTable;
}> => {
  const table = new InstanceTable();
  const router = await startRouter({
    index: createCatalogIndex([file_doric_tools_v1_tools]),
    instances: table,
    timings: {
      ...timings,
      helloTimeoutMs: 10_000,
      activationTimeoutMs: 10_000,
      healthIntervalMs: 30_000,
      healthTimeoutMs: 30_000,
      stallThresholdMs: 30_000,
      stopTimeoutMs: 2_000,
    },
    diagnostics: {
      health: () => {},
      hostStalled: () => {},
      registrationReplay: () => {},
    },
    onInvalid: () => {},
    onLost: () => {},
  });

  return { router, table };
};

/** The spawn environment of section 7, "Spawn", for `bundleId`/1/1. */
const spawnEnv = (
  port: number,
  token: string,
  bundleId: string,
): Record<string, string> => ({
  DORIC_ROUTER_URL: `http://127.0.0.1:${port}`,
  DORIC_INSTANCE_TOKEN: token,
  DORIC_BUNDLE_ID: bundleId,
  DORIC_GENERATION: '1',
  DORIC_INCARNATION: '1',
});

/** What the fixture's `activate` printed for one call. */
interface Probe {
  readonly probe: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly message?: string;
  readonly code?: string;
}

/**
 * The fixture's `src/host/main.ts`: `runBundle` whose `activate` makes each
 * assets call and prints one `Probe` line per call, then `{"probe":"done"}`.
 */
const mainSource = `import { runBundle } from ${JSON.stringify(sdk)};

const print = (line: unknown): void => {
  process.stdout.write(\`\${JSON.stringify(line)}\\n\`);
};

const probe = async (name: string, run: () => unknown): Promise<void> => {
  try {
    print({ probe: name, ok: true, value: await run() });
  } catch (error) {
    print({
      probe: name,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: unknown } | null)?.code,
    });
  }
};

const text = async (read: Promise<Uint8Array>): Promise<string> =>
  new TextDecoder().decode(await read);

runBundle({
  activate: async (context) => {
    const { assets } = context;

    await probe('skill', () => text(assets.read('src/host/skills/a.md')));
    await probe('other', () => text(assets.read('src/host/other.md')));
    await probe('dotdot', () =>
      text(assets.read('src/host/skills/../other.md')),
    );
    await probe('absolute', () => text(assets.read('/etc/passwd')));
    await probe('missing', () => text(assets.read('data/missing.txt')));
    await probe('extract', () => assets.extract());
    await probe('extractPrefix', () => assets.extract('src/host/skills'));
    await probe('native', () => assets.require('native-ish'));
    await probe('absent', () => assets.require('absent-pkg'));
    print({ probe: 'done' });
  },
});
`;

/** The files of a fixture bundle, `main.ts` and its would-be assets included. */
const bundleFiles: Record<string, string> = {
  'src/host/main.ts': mainSource,
  'src/host/skills/a.md': 'hello',
  'src/host/other.md': 'not an asset',
  'node_modules/native-ish/package.json': JSON.stringify({
    name: 'native-ish',
    version: '1.0.0',
    main: 'index.js',
  }),
  'node_modules/native-ish/index.js': `module.exports = { native: 'ish' };
`,
};

/**
 * Builds the bundle `id` in `root` with `host` as its manifest's `host`, runs
 * `node <dir>/dist/host/main.mjs` against a router (cwd elsewhere, so the
 * bundle directory comes from `process.argv[1]`), sends Activate, and
 * answers each probe the process printed, by name, with the bundle dir.
 */
const runFixture = async (
  root: string,
  id: string,
  host: Record<string, unknown> | undefined,
): Promise<{ readonly dir: string; readonly probes: Map<string, Probe> }> => {
  const dir = await writeBundle(root, id, {
    manifest: { ...manifest(id), ...(host === undefined ? {} : { host }) },
    files: bundleFiles,
  });

  await buildBundle(dir);

  const { router, table } = await startTestRouter();
  const key: InstanceKey = `${id}/1/1`;
  const { token } = table.issue({
    bundleId: id,
    version: '1.0.0',
    generation: 1,
    incarnation: 1,
  });
  const child = spawn(process.execPath, [join(dir, 'dist', 'host', 'main.mjs')], {
    cwd: root,
    env: { PATH: process.env.PATH, ...spawnEnv(router.port, token, id) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const probes = (): Probe[] =>
    stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Partial<Probe>)
      .filter((line): line is Probe => typeof line.probe === 'string');

  try {
    await until(
      () => table.get(key)?.state === 'connected' || child.exitCode !== null,
      'the process to connect',
    );
    assert.equal(child.exitCode, null, `exited before it connected: ${stderr}`);
    assert.equal(
      (await within(router.sendActivate(key), 'Activate', 10_000)).code,
      0,
      stderr,
    );
    await until(
      () => probes().some((line) => line.probe === 'done'),
      `the probes (stderr: ${stderr})`,
    );

    return {
      dir,
      probes: new Map(probes().map((line) => [line.probe, line])),
    };
  } finally {
    child.kill('SIGKILL');
    await router.close();
  }
};

/** The probe `name`, which must have failed; answers its message. */
const failed = (probes: Map<string, Probe>, name: string): string => {
  const line = probes.get(name);

  assert.ok(line !== undefined, `no probe ${name}`);
  assert.equal(line.ok, false, `${name} succeeded: ${JSON.stringify(line)}`);
  assert.equal(typeof line.message, 'string', name);

  return line.message as string;
};

/** Asserts `message` says `path` of `bundleId` is not listed in `host.assets`. */
const assertNotListed = (
  message: string,
  path: string,
  bundleId: string,
): void => {
  assert.ok(message.includes(path), `${message} does not name ${path}`);
  assert.ok(message.includes(bundleId), `${message} does not name ${bundleId}`);
  assert.match(message, /not listed/i);
};

// ---------------------------------------------------------------------------
// A built bundle with host.assets, run by runBundle

describe('context.assets in a built bundle run by runBundle', () => {
  const id = 'assets-demo';
  let result: { readonly dir: string; readonly probes: Map<string, Probe> };

  before(async () => {
    await withRoot(async (root) => {
      result = await runFixture(root, id, {
        assets: ['src/host/skills/*.md', 'data/missing.txt'],
      });
    });
  });

  test('read answers the bytes of a listed file, from the bundle directory of process.argv[1]', () => {
    assert.deepEqual(result.probes.get('skill'), {
      probe: 'skill',
      ok: true,
      value: 'hello',
    });
  });

  test('read refuses an existing file no glob lists, naming the path and the bundle', () => {
    assertNotListed(failed(result.probes, 'other'), 'src/host/other.md', id);
  });

  test('read refuses a path that is not in normal form as not listed', () => {
    assertNotListed(
      failed(result.probes, 'dotdot'),
      'src/host/skills/../other.md',
      id,
    );
    assertNotListed(failed(result.probes, 'absolute'), '/etc/passwd', id);
  });

  test('read of a listed path with no file rejects as missing, naming the path and the bundle', () => {
    const path = 'data/missing.txt';
    const message = failed(result.probes, 'missing');

    assert.ok(message.includes(path), message);
    assert.ok(message.includes(id), message);
    assert.doesNotMatch(message, /not listed/i);
    assert.match(message.replaceAll(path, ''), /missing/i);
  });

  test('extract resolves with the bundle directory, with and without a prefix', () => {
    assert.deepEqual(result.probes.get('extract'), {
      probe: 'extract',
      ok: true,
      value: result.dir,
    });
    assert.deepEqual(result.probes.get('extractPrefix'), {
      probe: 'extractPrefix',
      ok: true,
      value: result.dir,
    });
  });

  test('require loads a package from the bundle directory and throws MODULE_NOT_FOUND for an absent one', () => {
    assert.deepEqual(result.probes.get('native'), {
      probe: 'native',
      ok: true,
      value: { native: 'ish' },
    });
    failed(result.probes, 'absent');
    assert.equal(result.probes.get('absent')?.code, 'MODULE_NOT_FOUND');
  });
});

describe('context.assets in a built bundle without host.assets', () => {
  test('read refuses any path as not listed', async () => {
    await withRoot(async (root) => {
      const { probes } = await runFixture(root, 'no-assets', undefined);

      assertNotListed(
        failed(probes, 'skill'),
        'src/host/skills/a.md',
        'no-assets',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// startBundle without a bundle directory

describe('startBundle without bundleDir', () => {
  test('the Hello is accepted and context.assets.read rejects naming the bundle', async (t: TestContext) => {
    const { router, table } = await startTestRouter();

    t.after(() => router.close());

    const bundleId = 'no-dir';
    const { token } = table.issue({
      bundleId,
      version: '1.0.0',
      generation: 1,
      incarnation: 1,
    });
    let context: HostContext | undefined;

    await within(
      startBundle(
        {
          activate: (received) => {
            context = received;
          },
        },
        { env: spawnEnv(router.port, token, bundleId), exit: () => {} },
      ),
      'the Hello',
    );
    assert.equal(
      (await within(router.sendActivate(`${bundleId}/1/1`), 'Activate')).code,
      0,
    );
    assert.ok(context !== undefined, 'activate ran');

    await assert.rejects(
      within(context.assets.read('src/host/skills/a.md'), 'the read'),
      (error: unknown) => {
        assert.ok(error instanceof Error, `expected an Error: ${error}`);
        assert.ok(error.message.includes(bundleId), error.message);

        return true;
      },
    );
    await router.sendStop(`${bundleId}/1/1`);
  });
});
