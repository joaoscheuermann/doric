import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `papercraft`'s host part as a process (phase 3, S57, B1–B2): the bundle's
// build (`project.json`'s `test` depends on `build`) bundles
// `src/host/main.ts` into one `dist/host/main.mjs`, which imports `runBundle`
// from `bundle/host` and lists `papercraft.programs/v1`'s `ProgramsService`
// and the `HookHandlerService` as the static `[Service, implementation]`
// literals the build reads (S29). esbuild's JavaScript API is not bundled and
// no `.node` file is reached: the process loads its native packages through
// `context.assets.require` (D4). The kernel entry, the skill text beside the
// host, the sandbox runner and the client stay as they were until S62.
//
// The build's own `dist/` is only read here, never rewritten.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));
const workspaceRoot = join(bundleRoot, '..', '..', '..');
const dist = join(bundleRoot, 'dist');

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** The services `main.ts` lists, in order, by their full service names. */
const PAPERCRAFT_SERVICES = [
  'doric.papercraft.programs.v1.ProgramsService',
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

void test('B1: the build bundles papercraft’s host part into a runnable main.mjs without esbuild’s API and keeps the kernel entry, the skill text, the runner and the client', async () => {
  const main = join(dist, 'host', 'main.mjs');

  assert.ok(await nonEmpty(main), 'dist/host/main.mjs is empty');
  assert.doesNotMatch(
    await readFile(main, 'utf8'),
    /esbuild JavaScript API cannot be bundled/u,
    'main.mjs bundles esbuild’s JavaScript API',
  );
  for (const kept of [
    ['host', 'index.js'],
    ['host', 'skills', 'papercraft.md'],
    ['sandbox', 'runner.mjs'],
    ['client', 'index.js'],
  ]) {
    assert.ok(await nonEmpty(join(dist, ...kept)), `dist/${kept.join('/')}`);
  }

  const { code, stderr } = await runWithoutSpawnEnvironment(main);

  assert.equal(code, EXIT_CONFIG, stderr);
  assert.doesNotMatch(stderr, /Cannot find module/u);
  assert.doesNotMatch(stderr, /Dynamic require/u);
  assert.doesNotMatch(stderr, /\.node\b/u);
});

void test('B2: main.ts lists ProgramsService and the HookHandlerService statically', async () => {
  const services = await readStaticServices(bundleRoot);

  assert.deepEqual(services.map(fullName), PAPERCRAFT_SERVICES);
});
