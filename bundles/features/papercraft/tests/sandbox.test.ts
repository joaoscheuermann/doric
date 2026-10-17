// Component previews bundled inside the Project's sandbox: `compileComponent`
// with the sandbox bundler, over a fake sandbox whose workspace is a
// temporary folder and whose `node runner.mjs` runs the runner's own work
// (`runBundle`) with the host's esbuild.
//
// Contract matrix:
// - a Project whose bundle needs more files than the `files/v1` budget, and a
//   file larger than `files/v1` reads whole, compiles in the sandbox, with no
//   `files/v1` read; its classes reach `index.css`;
// - a Base UI specifier the window serves stays an import, and an icon of
//   `lucide-react` (a host package) is bundled from the host's copy;
// - an import the sandbox cannot resolve fails with `invalid_input` naming it;
// - a sandbox with another esbuild, or without `node`, compiles on the host
//   through `files/v1` instead;
// - no job folder is left in the workspace.
// - the sandbox image installs the esbuild version this bundle compiles with.

import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import type { Build } from '../src/host/bundle.js';
import { compileComponent } from '../src/host/compile.js';
import {
  bundleInSandbox,
  type RunnerSandbox,
  type SandboxBundler,
} from '../src/host/sandbox.js';
import type { RunnerInput } from '../src/sandbox/protocol.js';
import { runBundle } from '../src/sandbox/run.js';

const roots: string[] = [];

after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A workspace folder holding `files`. */
const workspace = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'papercraft-sandbox-'));
  roots.push(root);

  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

/**
 * A sandbox over `root`: `node` runs the runner's work in this process, with
 * the host's esbuild under `version` (its own when omitted), or is missing.
 */
const fakeSandbox = (
  root: string,
  options: { readonly version?: string; readonly node?: boolean } = {},
): RunnerSandbox => {
  const local = (path: string): string =>
    path.startsWith(root) ? path : join(root, path);

  return {
    id: `sandbox:${root}:${options.version ?? ''}:${String(options.node)}`,
    root,
    putFile: async (path, bytes) => {
      await mkdir(dirname(local(path)), { recursive: true });
      await writeFile(local(path), bytes);
    },
    getFile: async (path) => await readFile(local(path)),
    exec: async ({ cmd }) => {
      const done = (exitCode: number) => ({
        exitCode,
        stdout: '',
        stderr: '',
        stdoutBytes: new Uint8Array(),
        stderrBytes: new Uint8Array(),
      });
      const [command, ...args] = cmd;

      if (command === 'test') {
        return done(
          (await readFile(local(args[1] ?? '')).then(
            () => true,
            () => false,
          ))
            ? 0
            : 1,
        );
      }

      if (command === 'rm') {
        await rm(local(args[2] ?? ''), { recursive: true, force: true });

        return done(0);
      }

      if (command === 'node') {
        if (options.node === false) return done(127);

        const [, inputPath = '', outputPath = ''] = args;
        const input = JSON.parse(
          await readFile(local(inputPath), 'utf8'),
        ) as RunnerInput;
        const esbuild = await import('esbuild');
        const output = await runBundle(input, {
          root,
          loadEsbuild: async () => ({
            version: options.version ?? esbuild.version,
            build: esbuild.build as unknown as Build,
          }),
        });

        await writeFile(local(outputPath), JSON.stringify(output));

        return done(0);
      }

      throw new Error(`unexpected command ${cmd.join(' ')}`);
    },
  } as RunnerSandbox;
};

const bundlerOf =
  (sandbox: RunnerSandbox): SandboxBundler =>
  (request) =>
    bundleInSandbox(sandbox, request, {
      bytes: new TextEncoder().encode('// runner'),
      hash: 'test',
    });

/** A `files/v1` reader over `root` that counts its reads. */
const filesReader = (root: string) => {
  const reader = {
    reads: 0,
    read: async (path: string): Promise<string | undefined> => {
      reader.reads += 1;

      return await readFile(join(root, path), 'utf8').catch(() => undefined);
    },
  };

  return reader;
};

/** A package of `count` modules, each its own file. */
const manyModules = (count: number): Record<string, string> => {
  const files: Record<string, string> = {
    'node_modules/many/package.json': JSON.stringify({ main: 'index.js' }),
    'node_modules/many/index.js': [
      ...Array.from(
        { length: count },
        (_, index) =>
          `import { value as v${String(index)} } from './m${String(index)}.js';`,
      ),
      `export const total = [${Array.from({ length: count }, (_, index) => `v${String(index)}`).join(', ')}].length;`,
    ].join('\n'),
  };

  for (let index = 0; index < count; index += 1) {
    files[`node_modules/many/m${String(index)}.js`] =
      `export const value = ${String(index)};`;
  }

  return files;
};

describe('a component bundled in the sandbox', () => {
  test('compiles past the files/v1 budget and size, with no files/v1 read', async () => {
    const root = await workspace({
      ...manyModules(1_600),
      'src/big.ts': `export const big = ${JSON.stringify('x'.repeat(300_000))};`,
      'src/Button.tsx': [
        "import { total } from 'many';",
        "import { big } from './big.js';",
        'export default function Button() {',
        '  return <button className="px-7 text-brand">{total + big.length}</button>;',
        '}',
      ].join('\n'),
    });
    const files = filesReader(root);

    const compiled = await compileComponent(
      files.read,
      { path: 'src/Button.tsx' },
      bundlerOf(fakeSandbox(root)),
    );

    assert.equal(files.reads, 0);
    assert.equal(compiled.exportName, 'default');
    assert.match(compiled.js, /export\s*\{[^}]*mount/);
    assert.match(compiled.js, /m1599/);
    assert.match(compiled.css, /\.px-7/);
    assert.deepEqual(await readdir(join(root, '.doric/papercraft/jobs')), []);
  });

  test('leaves served Base UI to the window and bundles lucide from the host', async () => {
    const root = await workspace({
      'src/Panel.tsx': [
        "import { Collapsible } from '@base-ui/react/collapsible';",
        "import { Check } from 'lucide-react';",
        'export default function Panel() {',
        '  return <Collapsible.Root><Check /></Collapsible.Root>;',
        '}',
      ].join('\n'),
    });

    const compiled = await compileComponent(
      filesReader(root).read,
      { path: 'src/Panel.tsx' },
      bundlerOf(fakeSandbox(root)),
    );

    assert.match(compiled.js, /from\s*["']@base-ui\/react\/collapsible["']/);
    assert.doesNotMatch(compiled.js, /from\s*["']lucide-react["']/);
    assert.match(compiled.js, /lucide/);
  });

  test('fails naming an import the sandbox cannot resolve', async () => {
    const root = await workspace({
      'src/Broken.tsx': [
        "import { missing } from 'not-installed';",
        'export default () => <p>{missing}</p>;',
      ].join('\n'),
    });

    await assert.rejects(
      compileComponent(
        filesReader(root).read,
        { path: 'src/Broken.tsx' },
        bundlerOf(fakeSandbox(root)),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.code, 'invalid_input');
        assert.match(error.message, /not-installed/);

        return true;
      },
    );
  });

  for (const [name, options] of [
    ['another esbuild version', { version: '0.0.0' }],
    ['no node', { node: false }],
  ] as const) {
    test(`a sandbox with ${name} compiles on the host instead`, async () => {
      const root = await workspace({
        'src/Note.tsx': 'export default () => <p className="mt-3">note</p>;',
      });
      const files = filesReader(root);

      const compiled = await compileComponent(
        files.read,
        { path: 'src/Note.tsx' },
        bundlerOf(fakeSandbox(root, options)),
      );

      assert.ok(files.reads > 0);
      assert.match(compiled.css, /\.mt-3/);
    });
  }

  test('the sandbox image installs the esbuild this bundle compiles with', async () => {
    const dockerfile = await readFile(
      new URL(
        '../../../../../app/backend/doric-host/.sandbox.Dockerfile',
        import.meta.url,
      ),
      'utf8',
    );
    const { version } = await import('esbuild');

    assert.equal(/^ARG ESBUILD_VERSION=(\S+)$/m.exec(dockerfile)?.[1], version);
  });
});
