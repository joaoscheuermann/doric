import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildBundle } from 'bundle';

// `screen`'s host part as a process (phase 3, S49b, tests B17–B18):
// `buildBundle` bundles `src/host/main.ts` into one `dist/host/main.mjs`,
// which imports `runBundle` from `bundle/host` and lists `screen.sessions/v2`'s
// `SessionsService` as the static `[Service, implementation]` literal the
// build reads (S29, A61, A63). The kernel entry and the manifest stay as they
// were until S62.
//
// `buildBundle` rewrites `dist/`, which other test files read while they
// run, so this file builds a copy of the bundle inside the package, where
// it still resolves the workspace's dependencies.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, by their full service names. */
const SCREEN_SERVICES = ['doric.screen.sessions.v2.SessionsService'];

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
 * Copies what `buildBundle` reads (manifest, package, sources, tsc output),
 * without `dist/package.json` (the build writes it again): that nameless
 * package scope would resolve the generated files' imports of
 * `screen/contracts/gen/*` to the original bundle instead of the copy, and
 * `views_pb` imports `sessions_pb` that way, so the build would load two
 * `sessions.proto` files.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));
  const distPackage = join(bundleRoot, 'dist', 'package.json');

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), {
      recursive: true,
      filter: (source) => source !== distPackage,
    });
  }

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

void test('B17: the build bundles screen’s host part into a runnable main.mjs and keeps the kernel entry and the manifest', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  await buildBundle(copy);

  const main = join(copy, 'dist', 'host', 'main.mjs');

  assert.ok((await stat(main)).size > 0, 'dist/host/main.mjs is empty');
  assert.ok(
    (await stat(join(copy, 'dist', 'host', 'index.js'))).size > 0,
    'the kernel entry dist/host/index.js is gone',
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

void test('B18: main.ts lists screen.sessions/v2’s SessionsService statically', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), SCREEN_SERVICES);
});
