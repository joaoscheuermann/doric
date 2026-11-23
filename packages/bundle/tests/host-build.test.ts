import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { BuildError, buildBundle, runCli, stageBundles } from '../src/index.js';
import { manifest, withRoot, writeBundle } from './support/fixtures.js';

const run = promisify(execFile);

const exists = async (path: string) => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

/** A bundle with no contracts whose files are `files` (relative to the bundle directory). */
const writeHostBundle = (
  root: string,
  files: Record<string, string>,
  directory = 'demo',
  id = 'demo',
) => writeBundle(root, directory, { manifest: manifest(id), files });

const mainMjs = (dir: string) => join(dir, 'dist', 'host', 'main.mjs');

/** Copies dist/host/main.mjs alone into an empty directory and runs it with node. */
const runAlone = async (root: string, dir: string) => {
  const isolated = join(root, 'isolated');

  await mkdir(isolated, { recursive: true });
  await copyFile(mainMjs(dir), join(isolated, 'main.mjs'));

  const { stdout } = await run(process.execPath, ['main.mjs'], {
    cwd: isolated,
  });

  return stdout.trim();
};

const rejectsNaming = async (
  promise: Promise<unknown>,
  pattern: RegExp,
  buildError = true,
) =>
  assert.rejects(promise, (error: unknown) => {
    if (buildError) {
      assert.ok(error instanceof BuildError, `not a BuildError: ${error}`);
    }

    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);

    return true;
  });

void test('the host part bundles relative modules and CommonJS dependencies into one runnable main.mjs', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `import joined from 'cjs-dep';
import { greet } from './greet.js';

console.log(greet('host'), joined('a', 'b'));
`,
      'src/host/greet.ts': `export const greet = (name: string): string => \`hello \${name}\`;
`,
      'node_modules/cjs-dep/package.json': JSON.stringify({
        name: 'cjs-dep',
        version: '1.0.0',
        main: 'index.js',
      }),
      'node_modules/cjs-dep/index.js': `const path = require('node:path');
module.exports = (left, right) => path.posix.join(left, right);
`,
    });

    await buildBundle(dir);

    assert.equal(await runAlone(root, dir), 'hello host a/b');
  });
});

void test('literal dynamic imports and substitution-free templates build and run', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `const lazy = await import('./lazy.js');
const templated = await import(\`./templated.js\`);

console.log(lazy.value, templated.value);
`,
      'src/host/lazy.ts': `export const value = 'lazy';
`,
      'src/host/templated.ts': `export const value = 'templated';
`,
    });

    await buildBundle(dir);

    assert.equal(await runAlone(root, dir), 'lazy templated');
  });
});

void test('a dynamic import of a variable in main.ts fails naming its line', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `const name = './x.js';
await import(name);
`,
    });

    await rejectsNaming(buildBundle(dir), /src\/host\/main\.ts:2\b/);
    assert.equal(await exists(mainMjs(dir)), false);
  });
});

void test('a dynamic import of a template with a substitution fails naming its line', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `const name = 'x';

await import(\`./\${name}.js\`);
`,
    });

    await rejectsNaming(buildBundle(dir), /src\/host\/main\.ts:3\b/);
    assert.equal(await exists(mainMjs(dir)), false);
  });
});

void test('a non-literal dynamic import inside a node_modules dependency fails naming that file', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `import { load } from 'dyn-dep';

console.log(typeof load);
`,
      'node_modules/dyn-dep/package.json': JSON.stringify({
        name: 'dyn-dep',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
      }),
      'node_modules/dyn-dep/index.js': `export const load = (name) =>
  import(name);
`,
    });

    await rejectsNaming(
      buildBundle(dir),
      /node_modules\/dyn-dep\/index\.js:2\b/,
    );
    assert.equal(await exists(mainMjs(dir)), false);
  });
});

void test('importing a native .node addon fails naming the addon', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `import addon from './addon.node';

console.log(addon);
`,
      'src/host/addon.node': 'not really a native addon',
    });

    await rejectsNaming(buildBundle(dir), /addon\.node/, false);
    assert.equal(await exists(mainMjs(dir)), false);
  });
});

void test('a bundle without src/host/main.ts gets no dist/host/main.mjs', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {});

    await buildBundle(dir);

    assert.equal(await exists(join(dir, 'dist', 'manifest.json')), true);
    assert.equal(await exists(mainMjs(dir)), false);
  });
});

void test('rebuilding after src/host/main.ts is removed deletes the stale main.mjs', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {
      'src/host/main.ts': `console.log('once');
`,
    });

    await buildBundle(dir);
    assert.equal(await exists(mainMjs(dir)), true);

    await rm(join(dir, 'src', 'host', 'main.ts'));
    await buildBundle(dir);

    assert.equal(await exists(mainMjs(dir)), false);
  });
});

/**
 * A built bundle without a host source whose dist/host/main.mjs is then put
 * in place directly, so staging is observed independently of the host build.
 */
const writeBuiltWithMain = async (
  root: string,
  directory = 'demo',
  id = 'demo',
) => {
  const dir = await writeHostBundle(root, {}, directory, id);

  await buildBundle(dir);
  await mkdir(join(dir, 'dist', 'host'), { recursive: true });
  await writeFile(mainMjs(dir), "console.log('host');\n");

  return dir;
};

const commandJson = (destination: string, id = 'demo') =>
  join(destination, id, 'host', 'command.json');

const readCommand = async (destination: string, id = 'demo') =>
  JSON.parse(await readFile(commandJson(destination, id), 'utf8')) as unknown;

void test('dev staging writes host/command.json running the built main.mjs with node', async () => {
  await withRoot(async (root) => {
    const dir = await writeBuiltWithMain(root);
    const destination = join(root, 'staged');

    await stageBundles(destination, [dir], { dev: true });

    assert.deepEqual(await readCommand(destination), ['node', mainMjs(resolve(dir))]);
  });
});

void test('staging without dev writes no host/command.json', async () => {
  await withRoot(async (root) => {
    const dir = await writeBuiltWithMain(root);
    const destination = join(root, 'staged');

    await stageBundles(destination, [dir]);

    assert.equal(await exists(join(destination, 'demo', 'manifest.json')), true);
    assert.equal(await exists(commandJson(destination)), false);
  });
});

void test('dev staging writes no host/command.json for a bundle without main.mjs', async () => {
  await withRoot(async (root) => {
    const dir = await writeHostBundle(root, {});
    const destination = join(root, 'staged');

    await buildBundle(dir);
    await stageBundles(destination, [dir], { dev: true });

    assert.equal(await exists(join(destination, 'demo', 'manifest.json')), true);
    assert.equal(await exists(commandJson(destination)), false);
  });
});

/** Runs `body` with the working directory set to `cwd`, so a misparsed argument cannot touch the repository. */
const inDirectory = async (cwd: string, body: () => Promise<void>) => {
  const previous = process.cwd();

  process.chdir(cwd);

  try {
    await body();
  } finally {
    process.chdir(previous);
  }
};

void test('the stage --dev command stages listed bundles with host/command.json', async () => {
  await withRoot(async (root) => {
    const dir = await writeBuiltWithMain(root);
    const destination = join(root, 'staged');

    await inDirectory(root, () => runCli(['stage', '--dev', destination, dir]));

    assert.deepEqual(await readCommand(destination), ['node', mainMjs(resolve(dir))]);
  });
});

void test('the stage --dev --all command stages every bundle with host/command.json', async () => {
  await withRoot(async (root) => {
    const bundles = join(root, 'bundles');
    const dir = await writeBuiltWithMain(bundles, join('g1', 'a'), 'a');
    const destination = join(root, 'staged');

    await inDirectory(root, () =>
      runCli(['stage', '--dev', destination, '--all', bundles]),
    );

    assert.deepEqual(await readCommand(destination, 'a'), ['node', mainMjs(resolve(dir))]);
  });
});

void test('stage --dev without a destination rejects with the usage', async () => {
  await withRoot(async (root) => {
    await inDirectory(root, () =>
      rejectsNaming(runCli(['stage', '--dev']), /Usage: cli\.js/),
    );
  });
});
