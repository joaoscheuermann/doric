// Path B at the builder's boundary: a `component` source snapshots into the
// revision's three files — the fallback markup, the live module and its
// sheet — read from the Project through `files/v1` and compiled with the
// real esbuild and Tailwind compilers.
//
// Contract matrix:
// - a preview wrapper under `.doric/artifacts/drafts/` that imports the
//   Project's component (relative `.js` → `.tsx`) compiles into an ESM
//   `index.js` that exports `mount`, keeps `react` external and bundles the
//   imported file; `index.css` carries the utilities the sources use, mapped
//   to the generic theme's variables; each entry's hash is the hash of the bytes
//   handed over, and `index.html` stays the fallback markup;
// - a Project `tsconfig.json` `paths` alias resolves through the sandbox;
// - `lucide-react`, outside the window's import map, is bundled, not left
//   external;
// - only the React `mount` renders with and Base UI are left to the window:
//   every Base UI entrypoint its import map serves stays external, a
//   CommonJS `require` of one included, without a read of the Project, and a
//   Base UI path the map does not serve is the Project's; everything else is
//   the Project's — `bundle/contracts`, `radix-ui`, and the platform packages
//   (`desktop/client`, `bundle/runtime`) — bundled like any package;
// - a Node built-in fails naming the import;
// - `desktop/ui` comes from the Project's source, resolved through the
//   nearest tsconfig's `customConditions`: a component the Project edited
//   shows its edit, one it added is there too, and their classes reach the
//   sheet; `mount` itself imports nothing but React;
// - `entry` names the export to mount; a missing one, or a source with no
//   default and several components, fails naming the exports;
// - a source that does not compile, or an import nowhere to be found, fails
//   with `invalid_input` naming the file and the import;
// - an `html` source still builds its markup only.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  buildPreview,
  type PreviewSnapshot,
  snapshotPreview,
} from '../src/host/previews.js';
import { servicesFor, testCall } from './support/services.js';

const CARD = [
  "import { useState } from 'react';",
  "import { label } from './label.js';",
  '',
  'export interface CardProps { readonly title: string }',
  '',
  'export function Card({ title }: CardProps) {',
  '  const [count] = useState(3);',
  '  return (',
  '    <section className="rounded-lg bg-primary p-4">',
  '      <h2 className="text-primary-foreground">{title}</h2>',
  '      <p>{label(count)}</p>',
  '    </section>',
  '  );',
  '}',
].join('\n');

const LABEL =
  "export const label = (count: number): string => 'card-label-' + String(count);";

const WRAPPER = [
  "import { Card } from '../../../src/components/Card.js';",
  '',
  'export default function Preview() {',
  '  return <Card title="Checkout" />;',
  '}',
].join('\n');

const WRAPPER_PATH = '.doric/artifacts/drafts/card-preview.tsx';

const PROJECT: Record<string, string> = {
  'src/components/Card.tsx': CARD,
  'src/components/label.ts': LABEL,
  [WRAPPER_PATH]: WRAPPER,
};

const filesService = (files: Record<string, string>) => ({
  content: async ({ path }: { readonly path: string }) =>
    files[path] === undefined
      ? { status: 'ready', value: { status: 'not_found' } }
      : {
          status: 'ready',
          value: {
            status: 'read',
            path,
            content: files[path],
            truncated: false,
            binary: false,
          },
        },
});

const snapshot = (
  files: Record<string, string>,
  input: { source: 'html' | 'component'; path: string; entry?: string },
): Promise<PreviewSnapshot> =>
  snapshotPreview(
    servicesFor((id) => {
      if (id === 'files/v1') return filesService(files);
      throw new Error(`unexpected contract ${id}`);
    }),
    testCall,
    input,
  );

const textOf = (built: PreviewSnapshot, path: string): string => {
  const file = built.files.find((candidate) => candidate.path === path);
  assert.ok(file !== undefined, `no ${path} in the snapshot`);

  return Buffer.from(file.base64, 'base64').toString('utf8');
};

/** The static import specifiers of an ESM module. */
const importsOf = (js: string): string[] =>
  [...js.matchAll(/^import[^'"]*?from\s*["']([^"']+)["']/gm)].map(
    (match) => match[1] ?? '',
  );

const rejectsWith = async (
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, 'invalid_input');
    assert.match(error.message, pattern);

    return true;
  });
};

describe('component previews (path B)', () => {
  test('a draft wrapper compiles into a module, a sheet and the fallback markup', async () => {
    const built = await snapshot(PROJECT, {
      source: 'component',
      path: WRAPPER_PATH,
    });

    assert.deepEqual(
      built.entries.map((entry) => entry.path),
      ['index.html', 'index.js', 'index.css'],
    );

    // Each entry names the hash of exactly the bytes handed to the registry.
    for (const entry of built.entries) {
      const bytes = Buffer.from(
        built.files.find((file) => file.path === entry.path)?.base64 ?? '',
        'base64',
      );
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        entry.sha256,
      );
    }

    const js = textOf(built, 'index.js');
    assert.match(js, /export\s*\{[^}]*\bmount\b[^}]*\}/);
    // React comes from the window's import map; the Project files are inside.
    assert.ok(importsOf(js).includes('react'));
    assert.ok(importsOf(js).includes('react-dom/client'));
    assert.match(js, /card-label-/);

    const css = textOf(built, 'index.css');
    assert.match(css, /\.bg-primary\s*\{[^}]*var\(--primary\)/);
    assert.match(css, /\.p-4\s*\{/);
    // No theme token is defined as itself: under `:host` that cycle would
    // void the token the shadow host inherits.
    assert.doesNotMatch(css, /(--[\w-]+):\s*var\(\1\)/);

    // The fallback is still the source text, stamped with its origin.
    assert.match(
      built.markup,
      /data-papercraft-source="\.doric\/artifacts\/drafts\/card-preview\.tsx:1"/,
    );
  });

  test('the builder service answers the same three entries', async () => {
    const services = servicesFor((id) => {
      if (id === 'files/v1') return filesService(PROJECT);
      throw new Error(`unexpected contract ${id}`);
    });
    const built = await buildPreview(services, testCall, {
      source: 'component',
      path: WRAPPER_PATH,
    });

    assert.deepEqual(
      built.files.map((file) => file.path),
      ['index.html', 'index.js', 'index.css'],
    );
  });

  test("a tsconfig paths alias resolves through the Project's files", async () => {
    const built = await snapshot(
      {
        ...PROJECT,
        'tsconfig.json': `{
          // comments and trailing commas, as tsconfig files have them
          "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], }, },
        }`,
        'src/preview.tsx':
          'import { Card } from \'@/components/Card\';\nexport default () => <Card title="Alias" />;',
      },
      { source: 'component', path: 'src/preview.tsx' },
    );

    assert.match(textOf(built, 'index.js'), /card-label-/);
  });

  test('lucide-react is bundled, not left to the import map', async () => {
    const built = await snapshot(
      {
        'src/icon.tsx':
          'import { Check } from \'lucide-react\';\nexport default function Icon() { return <Check className="size-4" />; }',
      },
      { source: 'component', path: 'src/icon.tsx' },
    );
    const js = textOf(built, 'index.js');

    assert.ok(!importsOf(js).includes('lucide-react'));
    assert.match(textOf(built, 'index.css'), /\.size-4\s*\{/);
  });

  test("only what the window shares is left to it; bundle/contracts is the Project's", async () => {
    const built = await snapshot(
      {
        'node_modules/bundle/package.json': JSON.stringify({
          name: 'bundle',
          type: 'module',
          exports: { './contracts': './contracts.js' },
        }),
        'node_modules/bundle/contracts.js':
          "export const contractsLabel = 'project-contracts';",
        'src/badge.tsx': [
          "import { contractsLabel } from 'bundle/contracts';",
          'export default function Badge() {',
          '  return <span>{contractsLabel}</span>;',
          '}',
        ].join('\n'),
      },
      { source: 'component', path: 'src/badge.tsx' },
    );
    const js = textOf(built, 'index.js');
    const react = [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
    ];

    assert.match(js, /project-contracts/);
    // Without the Project's `desktop/ui`, `mount` imports none from the
    // window either.
    assert.deepEqual(
      importsOf(js).filter((specifier) => !react.includes(specifier)),
      [],
    );
  });

  test("Base UI is the window's: each entrypoint its import map serves stays external", async () => {
    // The Project has no Base UI of its own: nothing is read for it.
    const built = await snapshot(
      {
        'node_modules/cjs-menu/package.json':
          '{ "name": "cjs-menu", "main": "index.js" }',
        'node_modules/cjs-menu/index.js':
          "var merge = require('@base-ui/react/merge-props');\nexports.merged = function () { return merge.mergeProps({}, {}); };\n",
        'src/menu.tsx': [
          "import { Toggle } from '@base-ui/react';",
          "import { Popover } from '@base-ui/react/popover';",
          "import { merged } from 'cjs-menu';",
          'export default function Menu() {',
          '  return (',
          '    <Popover.Root>',
          '      <Popover.Trigger {...merged()}>menu-trigger</Popover.Trigger>',
          '      <Toggle />',
          '    </Popover.Root>',
          '  );',
          '}',
        ].join('\n'),
      },
      { source: 'component', path: 'src/menu.tsx' },
    );
    const js = textOf(built, 'index.js');
    const imports = importsOf(js);

    for (const specifier of [
      '@base-ui/react',
      '@base-ui/react/popover',
      '@base-ui/react/merge-props',
    ]) {
      assert.ok(imports.includes(specifier), `${specifier} is not external`);
    }
    assert.doesNotMatch(js, /__require\(\s*["']@base-ui/);
  });

  test('a Base UI path the window does not serve is resolved in the Project', async () => {
    const built = await snapshot(
      {
        'node_modules/@base-ui/react/package.json':
          '{ "name": "@base-ui/react", "main": "index.js" }',
        'node_modules/@base-ui/react/popover/root/PopoverRoot.js':
          "export const PopoverRoot = 'project-popover-root';",
        'src/deep.tsx': [
          "import { PopoverRoot } from '@base-ui/react/popover/root/PopoverRoot';",
          'export default () => <div>{PopoverRoot}</div>;',
        ].join('\n'),
      },
      { source: 'component', path: 'src/deep.tsx' },
    );
    const js = textOf(built, 'index.js');

    assert.match(js, /project-popover-root/);
    assert.ok(
      !importsOf(js).some((specifier) => specifier.startsWith('@base-ui/')),
    );
  });

  test('radix-ui is a Project package like any other', async () => {
    const built = await snapshot(
      {
        'node_modules/radix-ui/package.json':
          '{ "name": "radix-ui", "type": "module", "exports": { ".": "./index.js" } }',
        'node_modules/radix-ui/index.js':
          "export const Slot = { Root: () => 'project-radix-slot' };",
        'src/slot.tsx': [
          "import { Slot } from 'radix-ui';",
          'export default () => <Slot.Root />;',
        ].join('\n'),
      },
      { source: 'component', path: 'src/slot.tsx' },
    );
    const js = textOf(built, 'index.js');

    assert.match(js, /project-radix-slot/);
    assert.ok(!importsOf(js).includes('radix-ui'));
  });

  test('platform packages outside the import map are bundled from the Project', async () => {
    const built = await snapshot(
      {
        'node_modules/desktop/package.json': JSON.stringify({
          name: 'desktop',
          type: 'module',
          exports: { './client': './client.js' },
        }),
        'node_modules/desktop/client.js':
          "export const windowLabel = 'desktop-client-copy';",
        'node_modules/bundle/package.json': JSON.stringify({
          name: 'bundle',
          type: 'module',
          exports: {
            './runtime': './runtime.js',
            './contracts': './contracts.js',
          },
        }),
        'node_modules/bundle/contracts.js':
          'export class ContractError extends Error {}',
        'node_modules/bundle/runtime.js': [
          "import { ContractError } from 'bundle/contracts';",
          "export const runtimeLabel = 'bundle-runtime-copy-' + typeof ContractError;",
        ].join('\n'),
        'src/platform.tsx': [
          "import { runtimeLabel } from 'bundle/runtime';",
          "import { windowLabel } from 'desktop/client';",
          'export default function Platform() {',
          '  return <p>{windowLabel} {runtimeLabel}</p>;',
          '}',
        ].join('\n'),
      },
      { source: 'component', path: 'src/platform.tsx' },
    );
    const js = textOf(built, 'index.js');
    const imports = importsOf(js);

    assert.match(js, /desktop-client-copy/);
    assert.match(js, /bundle-runtime-copy-/);
    assert.ok(!imports.includes('desktop/client'));
    assert.ok(!imports.includes('bundle/runtime'));
    assert.ok(!imports.includes('bundle/contracts'));
  });

  test('desktop/ui comes from the Project source, an edited component and a new one alike', async () => {
    // The Project is a repository in a folder of the workspace whose own
    // `desktop` package edited a component the window also has and added
    // one it lacks; its \`dist\` was never built, so only its source resolves.
    const built = await snapshot(
      {
        'repo/tsconfig.base.json':
          '{ "compilerOptions": { "customConditions": ["@org/source"] } }',
        'repo/tsconfig.json': '{ "extends": "./tsconfig.base.json" }',
        'repo/node_modules/desktop/package.json': JSON.stringify({
          name: 'desktop',
          type: 'module',
          exports: {
            './ui/*': {
              '@org/source': './src/components/*.tsx',
              import: './dist/components/*.js',
            },
          },
        }),
        'repo/node_modules/desktop/src/components/popover.tsx': [
          "import type { ReactNode } from 'react';",
          'export const Popover = ({ children }: { children?: ReactNode }) => (',
          '  <div className="ring-[3px]" data-popover="project-edit">{children}</div>',
          ');',
        ].join('\n'),
        // Like the platform's own components, it renders through Base UI,
        // which is the window's: the Project's sandbox is never asked for it.
        'repo/node_modules/desktop/src/components/fancy-badge.tsx': [
          "import { useRender } from '@base-ui/react/use-render';",
          'export const FancyBadge = () =>',
          '  useRender({',
          '    render: <span className="tracking-[0.37em]" />,',
          '    props: { children: <span>fancy-badge-body</span> },',
          '  });',
        ].join('\n'),
        'repo/src/badge.tsx': [
          "import { FancyBadge } from 'desktop/ui/fancy-badge';",
          "import { Popover } from 'desktop/ui/popover';",
          'export default function Badge() {',
          '  return <Popover><FancyBadge /></Popover>;',
          '}',
        ].join('\n'),
      },
      { source: 'component', path: 'repo/src/badge.tsx' },
    );
    const js = textOf(built, 'index.js');
    const css = textOf(built, 'index.css');

    assert.match(js, /project-edit/);
    assert.match(js, /fancy-badge-body/);
    assert.ok(
      !importsOf(js).some((specifier) => specifier.startsWith('desktop/')),
    );
    assert.ok(importsOf(js).includes('@base-ui/react/use-render'));
    assert.match(css, /ring-\\\[3px\\\]/);
    assert.match(css, /tracking-\\\[0\\\.37em\\\]/);
  });

  test('a package subpath that is a folder with its own package.json resolves through it', async () => {
    // The layout before `exports` maps (`react-remove-scroll-bar/constants`).
    const built = await snapshot(
      {
        'node_modules/scroll-bar/package.json': '{ "name": "scroll-bar" }',
        'node_modules/scroll-bar/constants/package.json':
          '{ "main": "../dist/es5/constants.js", "module": "../dist/es2015/constants.js" }',
        'node_modules/scroll-bar/dist/es2015/constants.js':
          "export const gap = 'scroll-bar-constants';",
        'src/bar.tsx': [
          "import { gap } from 'scroll-bar/constants';",
          'export default () => <div>{gap}</div>;',
        ].join('\n'),
      },
      { source: 'component', path: 'src/bar.tsx' },
    );

    assert.match(textOf(built, 'index.js'), /scroll-bar-constants/);
  });

  test('a Node built-in fails naming the import', async () => {
    await rejectsWith(
      snapshot(
        {
          'src/disk.tsx':
            "import { readFileSync } from 'node:fs';\nexport default () => <div>{String(readFileSync)}</div>;",
        },
        { source: 'component', path: 'src/disk.tsx' },
      ),
      /node:fs/,
    );
  });

  test('entry names the export to mount', async () => {
    const built = await snapshot(PROJECT, {
      source: 'component',
      path: 'src/components/Card.tsx',
      entry: 'Card',
    });

    assert.match(textOf(built, 'index.js'), /export\s*\{[^}]*\bmount\b/);

    await rejectsWith(
      snapshot(PROJECT, {
        source: 'component',
        path: 'src/components/Card.tsx',
        entry: 'Missing',
      }),
      /no export "Missing".*Card/,
    );
  });

  test('a source with no default and several components asks for entry', async () => {
    await rejectsWith(
      snapshot(
        {
          'src/two.tsx':
            'export const A = () => <a />;\nexport const B = () => <b />;',
        },
        { source: 'component', path: 'src/two.tsx' },
      ),
      /exports: A, B.*pass `entry`/,
    );
  });

  test('a source that does not compile fails naming the file and line', async () => {
    await rejectsWith(
      snapshot(
        {
          'src/broken.tsx':
            'export default function Broken() {\n  return <div>;\n}',
        },
        { source: 'component', path: 'src/broken.tsx' },
      ),
      /did not compile[\s\S]*src\/broken\.tsx:\d+/,
    );
  });

  test('an import found nowhere fails naming it', async () => {
    await rejectsWith(
      snapshot(
        {
          'src/dep.tsx':
            "import confetti from 'canvas-confetti';\nexport default () => <div>{String(confetti)}</div>;",
        },
        { source: 'component', path: 'src/dep.tsx' },
      ),
      /canvas-confetti/,
    );

    await rejectsWith(
      snapshot(
        {
          'src/rel.tsx':
            "import { x } from './missing.js';\nexport default () => <div>{x}</div>;",
        },
        { source: 'component', path: 'src/rel.tsx' },
      ),
      /\.\/missing\.js/,
    );
  });

  test('an html source builds its markup only', async () => {
    const built = await snapshot(
      { 'src/page.html': '<p class="p-4">oi</p>' },
      { source: 'html', path: 'src/page.html' },
    );

    assert.deepEqual(
      built.entries.map((entry) => entry.path),
      ['index.html'],
    );
  });
});
