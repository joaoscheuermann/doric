import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildBundle } from '../src/index.js';
import { manifest, withRoot, writeBundle } from './support/fixtures.js';

// The host SDK's Node-only entry `bundle/host` (spec
// `docs/designs/grpc-processes.md`, section 10): a host part's `main.ts`
// imports `runBundle` from it, and `buildBundle` bundles that `main.ts` into
// one runnable `dist/host/main.mjs` (no `.node` file, no non-literal
// `import()`). The fixture resolves `bundle` to this package, as a bundle of
// the workspace does.

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The exit code of the host SDK when the spawn variables are missing. */
const EXIT_CONFIG = 70;

const runAlone = (
  main: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [main],
      { env: { PATH: process.env.PATH ?? '' }, timeout: 10_000 },
      (error, _stdout, stderr) => {
        resolve({
          code:
            error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          stderr: String(stderr),
        });
      },
    );
  });

void test('a host part importing runBundle from bundle/host builds into a main.mjs that runs alone', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: manifest('demo'),
      files: {
        'src/host/main.ts': `import { runBundle } from 'bundle/host';

runBundle({ services: [], activate: () => {} });
`,
      },
    });

    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await symlink(packageRoot, join(dir, 'node_modules', 'bundle'), 'dir');

    await buildBundle(dir);

    const built = join(dir, 'dist', 'host', 'main.mjs');

    assert.ok((await stat(built)).size > 0, 'dist/host/main.mjs is empty');

    // Alone in an empty directory: everything it needs is inside.
    const isolated = join(root, 'isolated');

    await mkdir(isolated);
    await copyFile(built, join(isolated, 'main.mjs'));

    const { code, stderr } = await runAlone(join(isolated, 'main.mjs'));

    assert.equal(code, EXIT_CONFIG, stderr);
    assert.doesNotMatch(stderr, /Cannot find module|Dynamic require/);
  });
});
