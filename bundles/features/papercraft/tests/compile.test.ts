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
//   to the app's theme variables; each entry's hash is the hash of the bytes
//   handed over, and `index.html` stays the fallback markup;
// - a Project `tsconfig.json` `paths` alias resolves through the sandbox;
// - `lucide-react`, outside the window's import map, is bundled, not left
//   external;
// - `mount` takes `desktop/ui`'s portal container provider from the import
//   map, and the sheet carries the shared components' classes only when the
//   previewed code itself imports `desktop/ui`;
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
    // void the token the surface copies onto the shadow host.
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

  test("the shared components' classes join the sheet only when the preview imports desktop/ui", async () => {
    // A class only `desktop/ui/popover` writes.
    const popoverOrigin = /--radix-popover-content-transform-origin/;
    const plain = await snapshot(PROJECT, {
      source: 'component',
      path: WRAPPER_PATH,
    });

    assert.ok(
      importsOf(textOf(plain, 'index.js')).includes(
        'desktop/ui/portal-container',
      ),
    );
    assert.doesNotMatch(textOf(plain, 'index.css'), popoverOrigin);

    const shared = await snapshot(
      {
        'src/menu.tsx': [
          "import { Popover, PopoverContent, PopoverTrigger } from 'desktop/ui/popover';",
          'export default function Menu() {',
          '  return (',
          '    <Popover>',
          '      <PopoverTrigger>Open</PopoverTrigger>',
          '      <PopoverContent>Body</PopoverContent>',
          '    </Popover>',
          '  );',
          '}',
        ].join('\n'),
      },
      { source: 'component', path: 'src/menu.tsx' },
    );

    assert.ok(
      importsOf(textOf(shared, 'index.js')).includes('desktop/ui/popover'),
    );
    assert.match(textOf(shared, 'index.css'), popoverOrigin);
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
