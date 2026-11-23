// S57 D4 (spec "Native code"): esbuild, `tailwindcss` and
// `@tailwindcss/oxide` load through one CommonJS loader. `nativeOf(load)`
// loads nothing until a method runs and throws what the loader throws;
// `moduleNative` is `nativeOf(createRequire(import.meta.url))`, the kernel's
// and the tests' default; the compiler and the sheet take their packages
// from the `native` they are given, and no host module keeps a value
// `import()` of a native package (the process bundles `src/host`).
//
// Contract matrix:
// - `nativeOf`: creating it asks the loader nothing; `esbuild()` answers the
//   loader's `esbuild` `build` and `version`; `tailwind()` answers
//   `tailwindcss`'s `compile` and `@tailwindcss/oxide`'s `Scanner`; a
//   package the loader cannot resolve throws the loader's error;
// - `moduleNative`: the packages `createRequire` resolves beside the host,
//   esbuild at the version this bundle depends on;
// - `compileComponent` / `compileStyles` fail with a `native` that cannot
//   load its package, and compile with one over `createRequire` of the
//   bundle's `package.json` (the process's `context.assets.require`);
// - no module under `src/host` keeps `import('esbuild')`,
//   `import('tailwindcss')` or `import('@tailwindcss/oxide')`.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileComponent } from '../src/host/compile.js';
import { compileStyles } from '../src/host/css.js';
import {
  moduleNative,
  type NativePackages,
  nativeOf,
} from '../src/host/native.js';

/** The bundle's folder: tests run from `dist-tests/tests`. */
const bundleRoot = fileURLToPath(new URL('../../', import.meta.url));

/** What `context.assets.require` is: `createRequire(<bundle dir>/package.json)`. */
const bundleRequire = createRequire(join(bundleRoot, 'package.json'));

/** The loader error for a package that cannot be resolved. */
const notFound = (specifier: string): Error =>
  Object.assign(new Error(`Cannot find module '${specifier}'`), {
    code: 'MODULE_NOT_FOUND',
  });

/** Native packages whose every load fails as an unresolvable package does. */
const missingNative: NativePackages = {
  esbuild: () => {
    throw notFound('esbuild');
  },
  tailwind: () => {
    throw notFound('tailwindcss');
  },
};

const SOURCE = [
  'export default function Hello() {',
  '  return <p className="p-4">hello</p>;',
  '}',
].join('\n');

/** A `files/v1`-style reader of one source file. */
const read = (path: string): Promise<string | undefined> =>
  Promise.resolve(path === 'src/Hello.tsx' ? SOURCE : undefined);

describe('nativeOf', () => {
  test('asks the loader nothing when it is created', () => {
    const asked: string[] = [];

    nativeOf((specifier) => {
      asked.push(specifier);
      return {};
    });

    assert.deepEqual(asked, []);
  });

  test('esbuild() answers the build and version the loader gives for esbuild', () => {
    const build = () => Promise.resolve({});
    const asked: string[] = [];
    const native = nativeOf((specifier) => {
      asked.push(specifier);
      return specifier === 'esbuild' ? { build, version: '9.9.9' } : {};
    });

    const api = native.esbuild();

    assert.equal(api.build, build);
    assert.equal(api.version, '9.9.9');
    assert.deepEqual(asked, ['esbuild']);
  });

  test('tailwind() answers compile from tailwindcss and Scanner from @tailwindcss/oxide', () => {
    const compile = () => Promise.resolve({});
    class Scanner {}
    const asked: string[] = [];
    const native = nativeOf((specifier) => {
      asked.push(specifier);
      if (specifier === 'tailwindcss') return { compile };
      if (specifier === '@tailwindcss/oxide') return { Scanner };
      return {};
    });

    const api = native.tailwind();

    assert.equal(api.compile, compile);
    assert.equal(api.Scanner, Scanner);
    assert.deepEqual([...asked].sort(), ['@tailwindcss/oxide', 'tailwindcss']);
  });

  test('throws the loader error for a package it cannot resolve', () => {
    const missing = notFound('esbuild');
    const native = nativeOf(() => {
      throw missing;
    });

    assert.throws(
      () => native.esbuild(),
      (error: unknown) => error === missing,
    );
  });
});

describe('moduleNative', () => {
  test('loads esbuild through createRequire beside the host, at the version the bundle depends on', async () => {
    const manifest = JSON.parse(
      await readFile(join(bundleRoot, 'package.json'), 'utf8'),
    ) as { readonly dependencies: Record<string, string> };
    const required = bundleRequire('esbuild') as {
      readonly build: unknown;
    };

    const api = moduleNative.esbuild();

    assert.equal(api.version, manifest.dependencies.esbuild);
    assert.equal(api.build, required.build);
  });

  test('loads the Tailwind compiler and scanner through createRequire beside the host', () => {
    const tailwindcss = bundleRequire('tailwindcss') as {
      readonly compile: unknown;
    };
    const oxide = bundleRequire('@tailwindcss/oxide') as {
      readonly Scanner: unknown;
    };

    const api = moduleNative.tailwind();

    assert.equal(api.compile, tailwindcss.compile);
    assert.equal(api.Scanner, oxide.Scanner);
  });
});

describe('the compiler over the native packages it is given', () => {
  test('compileComponent rejects naming esbuild when its native cannot load esbuild', async () => {
    await assert.rejects(
      compileComponent(
        read,
        { path: 'src/Hello.tsx' },
        undefined,
        undefined,
        undefined,
        missingNative,
      ),
      /Cannot find module 'esbuild'/u,
    );
  });

  test('compileStyles rejects naming tailwindcss when its native cannot load the compiler', async () => {
    await assert.rejects(
      compileStyles({
        read: () => Promise.resolve(undefined),
        sources: new Map([['src/Hello.tsx', SOURCE]]),
        native: missingNative,
      }),
      /Cannot find module 'tailwindcss'/u,
    );
  });

  test('compileComponent compiles with the packages createRequire of the bundle package.json loads', async () => {
    const compiled = await compileComponent(
      read,
      { path: 'src/Hello.tsx' },
      undefined,
      undefined,
      undefined,
      nativeOf(bundleRequire),
    );

    assert.match(compiled.js, /export\s*\{[^}]*\bmount\b[^}]*\}/u);
    assert.match(compiled.css, /\.p-4\s*\{/u);
  });
});

describe('the host sources', () => {
  test('keep no value import() of esbuild, tailwindcss or @tailwindcss/oxide', async () => {
    const dir = join(bundleRoot, 'src', 'host');
    const files = (await readdir(dir, { recursive: true })).filter((name) =>
      name.endsWith('.ts'),
    );
    const valueImport =
      /(?<!typeof\s*)\bimport\(\s*['"](?:esbuild|tailwindcss|@tailwindcss\/oxide)['"]\s*\)/u;

    const offenders: string[] = [];
    for (const name of files) {
      const text = await readFile(join(dir, name), 'utf8');
      if (valueImport.test(text)) offenders.push(name);
    }

    assert.deepEqual(offenders, []);
  });
});
