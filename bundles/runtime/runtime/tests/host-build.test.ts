import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { harness } from './router/support.js';

// `runtime`'s host part as a process (phase 3, S48c, contract §2.10, §8):
// `src/host/main.ts` lists every runtime service as the static
// `[Service, implementation]` literals the build reads (S29, A61, A63), and
// `buildHostPart` bundles it into one `dist/host/main.mjs`. The kernel entry
// `dist/host/index.js` is gone since S68d. Tests 28–30 of S48.
//
// The full `buildBundle` cannot run on a copy of runtime (§8, G2), and it
// rewrites the `dist/` other test files read while they run, so this file
// builds only the host part, of a copy inside the package.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const RUNTIME_SERVICES = [
  'doric.runtime.v2.RuntimeService',
  'doric.runtime.threads.v1.ThreadsService',
  'doric.runtime.attachments.v1.AttachmentsService',
  'doric.runtime.usage.v1.UsageService',
  'doric.runtime.lease.v1.LeaseService',
  'doric.runtime.workspace.v1.WorkspaceService',
  'doric.executor.session.v1.SessionService',
  'doric.hooks.v1.HookHandlerService',
];

/** One entry of `readStaticServices` (`bundle`'s build CLI). */
interface StaticServiceEntry {
  readonly protoFile: string;
  readonly service: string;
}

/** A module of the built `bundle` package, which `bundle` does not export. */
const bundleBuildModule = async <T>(file: string): Promise<T> =>
  (await import(
    pathToFileURL(
      join(workspaceRoot, 'packages', 'bundle', 'dist', 'build', file),
    ).href
  )) as T;

/** The build's own reader of the static `services` list (`dist/build/cli.js`). */
const readStaticServices = async (
  bundleDir: string,
): Promise<readonly StaticServiceEntry[]> => {
  const cli = await bundleBuildModule<{
    readonly readStaticServices: (
      dir: string,
    ) => Promise<readonly StaticServiceEntry[]>;
  }>('cli.js');

  return await cli.readStaticServices(bundleDir);
};

/** The build of the host part alone (`dist/build/host.js`). */
const buildHostPart = async (options: {
  readonly bundleDir: string;
}): Promise<boolean> => {
  const host = await bundleBuildModule<{
    readonly buildHostPart: (options: {
      readonly bundleDir: string;
    }) => Promise<boolean>;
  }>('host.js');

  return await host.buildHostPart(options);
};

/** `doric/storage/v1/storage.proto` + `StorageService` → `doric.storage.v1.StorageService`. */
const fullName = ({ protoFile, service }: StaticServiceEntry): string =>
  `${protoFile.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.')}.${service}`;

/**
 * Copies what the host build reads (manifest, package, sources, tsc output).
 *
 * The generated code imports its own files by the package name
 * (`runtime/contracts/gen/…`), so the copy gets a `node_modules/runtime` link
 * to itself: each of its proto files then loads once, from the copy, rather
 * than once from the copy and once from the workspace package.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
  }

  await mkdir(join(copy, 'node_modules'));
  await symlink(copy, join(copy, 'node_modules', 'runtime'), 'dir');

  return copy;
};

/** Runs `main.mjs` with no spawn variable and answers its exit and stderr. */
const runWithoutSpawnEnvironment = (
  main: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [main],
      {
        env: { PATH: process.env.PATH ?? '' },
        timeout: 10_000,
      },
      (error, _stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null;

        resolve({ code, stderr: String(stderr) });
      },
    );
  });

void test('28: buildHostPart bundles runtime’s host part into a non-empty main.mjs that exits 70 without the spawn variables', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  assert.equal(
    await buildHostPart({ bundleDir: copy }),
    true,
    'buildHostPart found no src/host/main.ts',
  );

  const main = join(copy, 'dist', 'host', 'main.mjs');

  assert.ok((await stat(main)).size > 0, 'dist/host/main.mjs is empty');
  // The copy's dist/ is the bundle's tsc output (X2: built from a clean dist).
  await assert.rejects(
    stat(join(copy, 'dist', 'host', 'index.js')),
    { code: 'ENOENT' },
    'the kernel entry dist/host/index.js still exists',
  );

  const { code, stderr } = await runWithoutSpawnEnvironment(main);

  assert.equal(code, EXIT_CONFIG, stderr);
  assert.doesNotMatch(stderr, /Cannot find module/);
  assert.doesNotMatch(stderr, /Dynamic require/);
});

void test('29: main.ts lists every runtime service and HookHandlerService statically, in order', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), RUNTIME_SERVICES);
});

void test('30: the router harness serves exactly the services main.ts lists', async (t) => {
  const h = harness();

  t.after(() => h.stop());

  const listed = (await readStaticServices(bundleRoot)).map(fullName);

  assert.deepEqual(new Set(h.served()), new Set(listed));
  assert.equal(h.served().length, listed.length);
});
