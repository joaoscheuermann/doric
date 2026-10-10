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
import { buildBundle } from '../src/index.js';
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
    ['desktop', '@lexical/react/LexicalComposer'],
    ['desktop', 'desktop-ui/button'],
    ['desktop', 'bundle'],
    ['client', 'bundle/runtime'],
    ['client', 'desktop-client'],
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
        `import { Button } from 'desktop-ui/button';`,
        `import { $getRoot } from 'lexical';`,
        `import { GitV1 } from 'git/contracts';`,
        `export const activate = () => [createElement, createRoot, Button, $getRoot, GitV1];`,
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
          'desktop-ui/button',
          'lexical',
          'git/contracts',
        ]),
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

void test('cli build refuses a client part that touches the DOM during activate', async () => {
  await withBundle(
    {
      'src/client/index.ts': `export const activate = () => { document.body.append('x'); };\n`,
    },
    async (dir) => {
      await assert.rejects(
        buildBundle(dir),
        /client part touched the DOM during activate/,
      );
    },
  );
});
