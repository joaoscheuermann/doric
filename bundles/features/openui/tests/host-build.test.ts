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

// `openui`'s host part as a process (phase 3, S56, B1–B2): `buildBundle`
// bundles `src/host/main.ts` into one `dist/host/main.mjs`, which imports
// `runBundle` from `bundle/host` and lists `openui.programs/v1`'s
// `ProgramsService`, `openui.questions/v1`'s `QuestionsService` and the
// `HookHandlerService` as the static `[Service, implementation]` literals the
// build reads (S29). The client, the skill text beside the host and the
// manifest stay as they were; the kernel entry is gone (S68c).
//
// `buildBundle` rewrites `dist/`, which other test files read while they
// run, so this file builds a copy of the bundle inside the package, where
// it still resolves the workspace's dependencies.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const OPENUI_SERVICES = [
  'doric.openui.programs.v1.ProgramsService',
  'doric.openui.questions.v1.QuestionsService',
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

/** `doric/hooks/v1/hooks.proto` + `HookHandlerService` → `doric.hooks.v1.HookHandlerService`. */
const fullName = ({ protoFile, service }: StaticServiceEntry): string =>
  `${protoFile.replace(/\/[^/]+\.proto$/, '').replaceAll('/', '.')}.${service}`;

/**
 * Copies what `buildBundle` reads (manifest, package, sources, tsc output).
 *
 * The generated code imports its own files by the package name
 * (`openui/contracts/gen/…`), and `dist/package.json` keeps a file under
 * `dist` from resolving that name to the copy itself, so the copy gets a
 * `node_modules/openui` link to itself: each of its proto files then loads
 * once, from the copy, rather than once from the copy and once from the
 * workspace package.
 */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
  }

  await mkdir(join(copy, 'node_modules'));
  await symlink(copy, join(copy, 'node_modules', 'openui'), 'dir');

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

void test('B1: the build bundles openui’s host part into a runnable main.mjs and keeps the client, the skill text and the manifest', async (t) => {
  const copy = await copyBundle();

  t.after(() => rm(copy, { recursive: true, force: true }));

  await buildBundle(copy);

  const dist = join(copy, 'dist');
  const main = join(dist, 'host', 'main.mjs');

  assert.ok(await nonEmpty(main), 'dist/host/main.mjs is empty');
  await assert.rejects(
    stat(join(dist, 'host', 'index.js')),
    { code: 'ENOENT' },
    'the kernel entry dist/host/index.js still exists',
  );
  for (const kept of [
    ['client', 'index.js'],
    ['host', 'skills', 'openui.md'],
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

void test('B2: main.ts lists ProgramsService, QuestionsService and the HookHandlerService statically', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), OPENUI_SERVICES);
});
