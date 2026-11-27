import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildBundle } from 'bundle';

// `host-config`'s host part as a process (phase 3, S45b, B17): `buildBundle`
// bundles `src/host/main.ts` into one `dist/host/main.mjs`, which imports
// `runBundle` from `bundle/host` and lists `host-config/v1`'s
// `HostConfigService`, `secrets/v1`'s `ReferenceSourceService` and `hooks/v1`'s
// `HookHandlerService` as the static `[Service, implementation]` literals the
// build reads (S29, A61, A63). The manifest stays as
// it was; the kernel entry is gone (S68a).
//
// `buildBundle` rewrites `dist/`, which other test files read while they
// run, so this file builds a copy of the bundle inside the package, where
// it still resolves the workspace's dependencies.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const HOST_CONFIG_SERVICES = [
  'doric.host_config.v1.HostConfigService',
  'doric.secrets.v1.ReferenceSourceService',
  'doric.hooks.v1.HookHandlerService',
];

/** One entry of `readStaticServices` (`bundle`'s build CLI). */
interface StaticServiceEntry {
  readonly protoFile: string;
  readonly service: string;
}

/**
 * The build's own reader of the static `services` list, loaded from the
 * built `bundle` package (`dist/build/cli.js`), which does not export it.
 */
const readStaticServices = async (
  bundleDir: string,
): Promise<readonly StaticServiceEntry[]> => {
  const cli = (await import(
    pathToFileURL(
      join(workspaceRoot, 'packages', 'bundle', 'dist', 'build', 'cli.js'),
    ).href
  )) as {
    readonly readStaticServices: (
      dir: string,
    ) => Promise<readonly StaticServiceEntry[]>;
  };

  return await cli.readStaticServices(bundleDir);
};

/** `doric/storage/v1/storage.proto` + `StorageService` → `doric.storage.v1.StorageService`. */
const fullName = ({ protoFile, service }: StaticServiceEntry): string =>
  `${protoFile.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.')}.${service}`;

/**
 * Copies what `buildBundle` reads (manifest, package, sources, tsc output).
 *
 * The generated code imports its own files by the package name
 * (`host-config/contracts/gen/…`), and `dist/package.json` keeps a file
 * under `dist` from resolving that name to the copy itself, so the copy gets a
 * `node_modules/host-config` link to itself: each of its proto files then
 * loads once, from the copy, rather than once from the copy and once from the
 * workspace package.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
  }

  await mkdir(join(copy, 'node_modules'));
  await symlink(copy, join(copy, 'node_modules', 'host-config'), 'dir');

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

void test('the build bundles host-config’s host part into a runnable main.mjs and keeps the manifest', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  await buildBundle(copy);

  const main = join(copy, 'dist', 'host', 'main.mjs');

  assert.ok((await stat(main)).size > 0, 'dist/host/main.mjs is empty');
  await assert.rejects(
    stat(join(copy, 'dist', 'host', 'index.js')),
    { code: 'ENOENT' },
    'the kernel entry dist/host/index.js still exists',
  );
  await assert.rejects(
    stat(join(copy, 'dist', 'kernel.js')),
    { code: 'ENOENT' },
    'the kernel entry dist/kernel.js still exists',
  );
  assert.ok(
    (await readFile(join(copy, 'dist', 'manifest.json'))).equals(
      await readFile(join(copy, 'manifest.json')),
    ),
    'dist/manifest.json differs from manifest.json',
  );

  const { code, stderr } = await runWithoutSpawnEnvironment(main);

  assert.equal(code, EXIT_CONFIG, stderr);
  assert.doesNotMatch(stderr, /Cannot find module/);
  assert.doesNotMatch(stderr, /Dynamic require/);
});

void test('main.ts lists HostConfigService, ReferenceSourceService and HookHandlerService statically, in order', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), HOST_CONFIG_SERVICES);
});
