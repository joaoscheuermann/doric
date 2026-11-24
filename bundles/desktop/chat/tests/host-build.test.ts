// B1–B2 (phase 3, S58): `buildBundle` bundles `chat`'s host part,
// `src/host/main.ts`, into one `dist/host/main.mjs`, which imports
// `runBundle` from `bundle/host` and lists `chat.composer/v1`'s
// `ComposerService` and the `message` kind's `ComposerFlushHandlerService`
// as the static `[Service, implementation]` literals the build reads (S29).
// The desktop entry, the client and the manifest stay as they were: the
// window keeps the desktopMain composer until phase 5.
//
// `buildBundle` rewrites `dist/`, which other test files read while they
// run, so this file builds a copy of the bundle inside the package, where
// it still resolves the workspace's dependencies.

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

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const CHAT_SERVICES = [
  'doric.chat.composer.v1.ComposerService',
  'doric.chat.composer.v1.ComposerFlushHandlerService',
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

/** `doric/chat/composer/v1/composer.proto` + `ComposerService` → `doric.chat.composer.v1.ComposerService`. */
const fullName = ({ protoFile, service }: StaticServiceEntry): string =>
  `${protoFile.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.')}.${service}`;

/**
 * Copies what `buildBundle` reads (manifest, package, sources, tsc output).
 *
 * The generated code imports its own files by the package name
 * (`chat/contracts/gen/…`), and `dist/package.json` keeps a file under
 * `dist` from resolving that name to the copy itself, so the copy gets a
 * `node_modules/chat` link to itself: each of its proto files then loads
 * once, from the copy, rather than once from the copy and once from the
 * workspace package.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
  }

  await mkdir(join(copy, 'node_modules'));
  await symlink(copy, join(copy, 'node_modules', 'chat'), 'dir');

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

const nonEmpty = async (path: string): Promise<boolean> =>
  (await stat(path)).size > 0;

void test('B1: the build bundles chat’s host part into a runnable main.mjs and keeps the desktop entry, the client and the manifest', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  await buildBundle(copy);

  const dist = join(copy, 'dist');
  const main = join(dist, 'host', 'main.mjs');

  assert.ok(await nonEmpty(main), 'dist/host/main.mjs is empty');
  for (const kept of [
    ['desktop', 'index.js'],
    ['client', 'index.js'],
  ]) {
    assert.ok(await nonEmpty(join(dist, ...kept)), `dist/${kept.join('/')}`);
  }
  assert.ok(
    (await readFile(join(dist, 'manifest.json'))).equals(
      await readFile(join(copy, 'manifest.json')),
    ),
    'dist/manifest.json differs from manifest.json',
  );

  const { code, stderr } = await runWithoutSpawnEnvironment(main);

  assert.equal(code, EXIT_CONFIG, stderr);
  assert.doesNotMatch(stderr, /Cannot find module/);
  assert.doesNotMatch(stderr, /Dynamic require/);
});

void test('B2: main.ts lists ComposerService, then ComposerFlushHandlerService, statically', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), CHAT_SERVICES);
});
