import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBundle } from 'bundle';

// The host part as a process (phase 3, S38; T3.9, AC3.11): `buildBundle`
// bundles `src/host/main.ts` into one `dist/host/main.mjs`, which imports
// `runBundle` from `bundle/host` and the adapters from `storage/rpc`, so both
// entries must bundle under esbuild (no `.node` file, no non-literal
// `import()`). The kernel entry and the manifest stay as they were.
//
// `buildBundle` rewrites `dist/`, which `activate.test.ts` stages from while
// the other test files run, so this file builds a copy of the bundle inside
// the package, where it still resolves the workspace's dependencies.

const bundleRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

/** Copies what `buildBundle` reads (manifest, package, sources, tsc output). */
const copyBundle = async (): Promise<string> => {
  const copy = await mkdtemp(join(bundleRoot, 'dist-tests', 'host-build-'));

  for (const entry of ['manifest.json', 'package.json', 'src', 'dist']) {
    await cp(join(bundleRoot, entry), join(copy, entry), { recursive: true });
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

void test('the build bundles the host part into a runnable main.mjs and keeps the kernel entry and the manifest', async (t) => {
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
