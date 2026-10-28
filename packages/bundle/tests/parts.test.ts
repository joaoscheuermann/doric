// Desktop and client part builds (stage 8, 19.1): esbuild bundles each part
// as ESM with the platform specifiers external, a bundle's own contracts
// become `<id>/contracts` [S8-18], forbidden imports and `@theme` fail, and
// `cli build` records desktopMain and client entries in the descriptor.
// Real files and the real esbuild and Tailwind compilers.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildParts, PartBuildError } from '../src/build/parts.js';
import { buildBundle, distributionFiles } from '../src/index.js';
import { contractsUrl, manifest } from './support/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A bundle directory inside the workspace, so `zod` and `tailwindcss`
 * resolve, with a local `bundle/contracts` package over the compiled
 * contracts the tests load.
 */
const withBundle = async (
  files: Readonly<Record<string, string>>,
  run: (dir: string) => Promise<void>,
  options: { readonly provides?: readonly string[] } = {},
) => {
  const parent = join(here, '..', '.parts-tmp');

  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, 'b-'));
  const dir = join(root, 'demo');
  const all: Record<string, string> = {
    'manifest.json': JSON.stringify(
      manifest('demo', { provides: [...(options.provides ?? [])] }),
    ),
    'node_modules/bundle/package.json': JSON.stringify({
      name: 'bundle',
      type: 'module',
      exports: { './contracts': './contracts.js' },
    }),
    'node_modules/bundle/contracts.js': `export * from ${JSON.stringify(contractsUrl)};\n`,
    ...files,
  };

  try {
    for (const [path, content] of Object.entries(all)) {
      const target = path.startsWith('node_modules/')
        ? join(root, path)
        : join(dir, path);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    await run(dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const read = (dir: string, path: string) =>
  readFile(join(dir, 'dist', ...path.split('/')), 'utf8');

const importsOf = (source: string): string[] =>
  [...source.matchAll(/from\s*["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  );

void test('a desktop part keeps the platform imports and its own contracts external', async () => {
  await withBundle(
    {
      'src/contracts/index.ts': `export const DemoV1 = 'demo/v1';\n`,
      'src/contracts/extra.ts': `export const extra = 1;\n`,
      'src/desktop/helper.ts': `export const helper = () => 'inlined-helper';\n`,
      'src/desktop/index.ts': [
        `import { z } from 'zod';`,
        `import { defineService } from 'bundle/contracts';`,
        `import { DemoV1 } from '../contracts/index.js';`,
        `import { extra } from '../contracts/extra.js';`,
        `import { helper } from './helper.js';`,
        `import { readFile } from 'node:fs/promises';`,
        `export const activate = () => [z, defineService, DemoV1, extra, helper(), readFile];`,
        '',
      ].join('\n'),
    },
    async (dir) => {
      const built = await buildParts({ bundleDir: dir, mode: 'production' });

      assert.deepEqual(built, { desktopMain: 'desktop/index.js' });

      const output = await read(dir, 'desktop/index.js');

      assert.deepEqual(
        new Set(importsOf(output)),
        new Set([
          'zod',
          'bundle/contracts',
          'demo/contracts',
          'node:fs/promises',
        ]),
      );
      assert.match(output, /inlined-helper/);
    },
  );
});

void test('a part with a forbidden import fails the build', async () => {
  for (const [part, specifier] of [
    ['desktop', 'react'],
    ['desktop', '@base-ui/react/popover'],
    ['desktop', '@lexical/react/LexicalComposer'],
    ['desktop', 'desktop/ui/button'],
    ['desktop', 'bundle'],
    ['client', 'bundle/runtime'],
    ['client', 'desktop'],
    ['client', 'desktop/client'],
  ] as const) {
    await withBundle(
      {
        [`src/${part}/index.ts`]: `import * as forbidden from '${specifier}';\nexport const activate = () => forbidden;\n`,
      },
      async (dir) => {
        await assert.rejects(
          buildParts({ bundleDir: dir, mode: 'production' }),
          (error: unknown) =>
            error instanceof PartBuildError &&
            error.message.includes(
              `A ${part} part must not import "${specifier}".`,
            ),
          `${part} ${specifier}`,
        );
      },
    );
  }
});

void test('a client part leaves the import-map specifiers to the window', async () => {
  await withBundle(
    {
      'src/client/index.ts': [
        `import { createElement } from 'react';`,
        `import { createRoot } from 'react-dom/client';`,
        `import { Popover } from '@base-ui/react/popover';`,
        `import { mergeProps } from '@base-ui/react';`,
        `import { Button } from 'desktop/ui/button';`,
        `import { $getRoot } from 'lexical';`,
        `import { GitV1 } from 'git/contracts';`,
        `export const activate = () => [createElement, createRoot, Popover, mergeProps, Button, $getRoot, GitV1];`,
        '',
      ].join('\n'),
    },
    async (dir) => {
      await buildParts({ bundleDir: dir, mode: 'production' });

      assert.deepEqual(
        new Set(importsOf(await read(dir, 'client/index.js'))),
        new Set([
          'react',
          'react-dom/client',
          '@base-ui/react/popover',
          '@base-ui/react',
          'desktop/ui/button',
          'lexical',
          'git/contracts',
        ]),
      );
    },
  );
});

void test('a bundled CommonJS dependency that requires an external gets the window instance', async () => {
  await withBundle(
    {
      'node_modules/cjs-dep/package.json': JSON.stringify({
        name: 'cjs-dep',
        main: 'index.js',
      }),
      'node_modules/cjs-dep/index.js':
        "var React = require('react');\nvar Popover = require('@base-ui/react/popover');\nexports.useIt = function () { return [React.useState, Popover]; };\n",
      'src/client/index.ts': [
        `import { useIt } from 'cjs-dep';`,
        `export const activate = () => [useIt];`,
        '',
      ].join('\n'),
    },
    async (dir) => {
      await buildParts({ bundleDir: dir, mode: 'production' });

      const source = await read(dir, 'client/index.js');

      assert.deepEqual(
        new Set(importsOf(source)),
        new Set(['react', '@base-ui/react/popover']),
      );
      assert.doesNotMatch(
        source,
        /__require\(\s*["'](?:react|@base-ui\/react\/popover)["']\s*\)/,
      );
    },
  );
});

void test('client CSS compiles the utilities its sources use and refuses @theme', async () => {
  await withBundle(
    {
      'src/client/index.ts': `export const activate = () => 'flex gap-2';\n`,
      'src/client/styles.css': `@import 'tailwindcss/utilities.css' layer(utilities);\n@source './';\n`,
    },
    async (dir) => {
      const built = await buildParts({ bundleDir: dir, mode: 'production' });

      assert.equal(built.clientStyles, 'client/styles.css');

      const css = await read(dir, 'client/styles.css');

      assert.match(css, /\.flex\s*\{\s*display:\s*flex/);
      assert.doesNotMatch(css, /\.grid\s*\{/);
    },
  );

  await withBundle(
    {
      'src/client/styles.css': `@theme { --color-brand: red; }\n`,
    },
    async (dir) => {
      await assert.rejects(
        buildParts({ bundleDir: dir, mode: 'production' }),
        /must not extend @theme/,
      );
    },
  );
});

const servicePart = (id: string) =>
  [
    `import { z } from 'zod';`,
    `import { defineMethod, defineService } from 'bundle/contracts';`,
    `export const activate = ({ services }) => {`,
    `  services.provide(defineService('${id}', {`,
    `    ping: defineMethod({ input: z.tuple([]), output: z.literal('pong'), execute: () => 'pong' }),`,
    `  }));`,
    `};`,
    '',
  ].join('\n');

void test('cli build records desktopMain and client entries from the built parts', async () => {
  await withBundle(
    {
      'src/desktop/index.ts': servicePart('demo.desk/v1'),
      'src/client/index.ts': servicePart('demo.view/v1'),
    },
    async (dir) => {
      const { descriptor } = await buildBundle(dir);

      assert.deepEqual(
        descriptor.contracts.map(({ id, environment }) => [id, environment]),
        [
          ['demo.desk/v1', 'desktopMain'],
          ['demo.view/v1', 'client'],
        ],
      );
    },
    { provides: ['demo.desk/v1@1.0.0', 'demo.view/v1@1.0.0'] },
  );
});

void test('cli build imports and dry-activates a client part with the DOM shim, then removes it', async () => {
  await withBundle(
    {
      'src/client/index.ts': [
        `import { defineMethod, defineService } from 'bundle/contracts';`,
        `import { z } from 'zod';`,
        // Import-time DOM through a custom element class only.
        `class DemoView extends HTMLElement {}`,
        `export const activate = ({ services }) => {`,
        `  customElements.define('demo-view', DemoView);`,
        `  document.body.append(document.createElement('demo-view'));`,
        `  window.localStorage.setItem('k', 'v');`,
        `  new ResizeObserver(() => undefined).observe(document.body);`,
        `  matchMedia('(prefers-color-scheme: dark)');`,
        `  services.provide(defineService('demo.view/v1', {`,
        `    ping: defineMethod({ input: z.tuple([]), output: z.literal('pong'), execute: () => 'pong' }),`,
        `  }));`,
        `};`,
        '',
      ].join('\n'),
    },
    async (dir) => {
      const { descriptor } = await buildBundle(dir);

      assert.deepEqual(
        descriptor.contracts.map(({ id, environment }) => [id, environment]),
        [['demo.view/v1', 'client']],
      );

      for (const name of [
        'HTMLElement',
        'customElements',
        'document',
        'window',
        'localStorage',
        'ResizeObserver',
        'matchMedia',
      ]) {
        assert.equal(name in globalThis, false, name);
      }
    },
    { provides: ['demo.view/v1@1.0.0'] },
  );
});

void test('cli build names the client module that touches more of the DOM at import time', async () => {
  await withBundle(
    {
      'src/client/index.ts': `document.fonts.add('x');\nexport const activate = () => undefined;\n`,
    },
    async (dir) => {
      await assert.rejects(buildBundle(dir), (error: unknown) => {
        const message = error instanceof Error ? error.message : '';

        return (
          message.startsWith('Loading client/index.js failed:') &&
          message.includes('class … extends HTMLElement') &&
          message.includes('dynamic import()')
        );
      });
      assert.equal('document' in globalThis, false);
    },
  );
});

void test('client workers are self-contained modules next to the part', async () => {
  await withBundle(
    {
      'src/client/index.ts': `export const activate = () => new URL('./workers/editor.js', import.meta.url);\n`,
      'src/client/workers/editor.ts': [
        `import { z } from 'zod';`,
        `import { helper } from '../helper.js';`,
        `self.onmessage = () => [z.string().parse('ok'), helper()];`,
        '',
      ].join('\n'),
      'src/client/helper.ts': `export const helper = () => 'inlined-worker-helper';\n`,
    },
    async (dir) => {
      const built = await buildParts({ bundleDir: dir, mode: 'production' });

      assert.deepEqual(built, { client: 'client/index.js' });

      const worker = await read(dir, 'client/workers/editor.js');

      assert.deepEqual(importsOf(worker), []);
      assert.match(worker, /inlined-worker-helper/);
    },
  );
});

void test('client frames are modules of their own with only the frame import map external', async () => {
  await withBundle(
    {
      'src/contracts/index.ts': `export const marker = 'inlined-contract';\n`,
      'src/client/index.ts': `export const activate = () => new URL('./frames/preview.js', import.meta.url);\n`,
      'src/client/frames/preview.ts': [
        `import { createElement } from 'react';`,
        `import { jsx } from 'react/jsx-runtime';`,
        `import { jsxDEV } from 'react/jsx-dev-runtime';`,
        `import { flushSync } from 'react-dom';`,
        `import { createRoot } from 'react-dom/client';`,
        `import { mergeProps } from '@base-ui/react';`,
        `import { Popover } from '@base-ui/react/popover';`,
        `import { z } from 'zod';`,
        `import { marker } from '../../contracts/index.js';`,
        `import { helper } from './preview/helper.js';`,
        `export const parts = [createElement, jsx, jsxDEV, flushSync, createRoot, mergeProps, Popover, z.string().parse('ok'), marker, helper()];`,
        '',
      ].join('\n'),
      'src/client/frames/preview/helper.ts': `export const helper = () => 'inlined-frame-helper';\n`,
    },
    async (dir) => {
      const built = await buildParts({ bundleDir: dir, mode: 'production' });

      assert.deepEqual(built.frames, ['client/frames/preview.js']);

      const frame = await read(dir, 'client/frames/preview.js');

      assert.deepEqual(
        new Set(importsOf(frame)),
        new Set([
          'react',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          'react-dom',
          'react-dom/client',
          '@base-ui/react',
          '@base-ui/react/popover',
        ]),
      );
      assert.match(frame, /inlined-frame-helper/);
      assert.match(frame, /inlined-contract/);
      // The frame's modules are bundled into it, not entries of their own.
      await assert.rejects(read(dir, 'client/frames/preview/helper.js'));
    },
  );
});

void test('a frame with an import its document cannot resolve fails the build', async () => {
  for (const specifier of [
    'desktop/ui/button',
    'lexical',
    'react/compiler-runtime',
    'bundle/contracts',
    'git/contracts',
    'desktop/client',
  ]) {
    await withBundle(
      {
        'src/client/frames/preview.ts': `import * as forbidden from '${specifier}';\nexport const parts = [forbidden];\n`,
      },
      async (dir) => {
        await assert.rejects(
          buildParts({ bundleDir: dir, mode: 'production' }),
          (error: unknown) =>
            error instanceof PartBuildError &&
            error.message.includes(
              `A frame part must not import "${specifier}".`,
            ),
          specifier,
        );
      },
    );
  }
});

void test('cli build never loads a frame, and the frame ships with the client', async () => {
  await withBundle(
    {
      'src/client/index.ts': servicePart('demo.view/v1'),
      // A frame touches its document at import time: loading it in Node
      // would throw.
      'src/client/frames/preview.ts': `document.body.append(document.createElement('div'));\nwindow.addEventListener('message', () => undefined);\n`,
    },
    async (dir) => {
      await buildBundle(dir);

      const files = await distributionFiles(join(dir, 'dist'));

      assert.ok(
        files.some((file) => file.path === 'client/frames/preview.js'),
        files.map((file) => file.path).join(', '),
      );
    },
    { provides: ['demo.view/v1@1.0.0'] },
  );
});

void test('CSS the client imports is appended after the Tailwind output, and fonts become files', async () => {
  await withBundle(
    {
      'src/client/index.ts': `import './vendor.css';\nexport const activate = () => 'flex';\n`,
      'src/client/vendor.css': `@font-face { font-family: Demo; src: url('./demo.woff2'); }\n.vendor-rule { color: red; }\n`,
      'src/client/demo.woff2': 'wOF2',
      'src/client/styles.css': `@import 'tailwindcss/utilities.css' layer(utilities);\n@source './';\n`,
    },
    async (dir) => {
      const built = await buildParts({ bundleDir: dir, mode: 'production' });

      assert.equal(built.clientStyles, 'client/styles.css');

      const css = await read(dir, 'client/styles.css');
      const tailwindAt = css.search(/\.flex\s*\{/);
      const vendorAt = css.indexOf('.vendor-rule');

      assert.ok(tailwindAt >= 0 && vendorAt > tailwindAt, css);

      const font = /url\("?\.\/(assets\/demo-[A-Z0-9]+\.woff2)"?\)/.exec(css);

      assert.ok(font !== null, css);
      assert.equal(await read(dir, `client/${font[1]}`), 'wOF2');
      await assert.rejects(read(dir, 'client/index.css'));
    },
  );
});
