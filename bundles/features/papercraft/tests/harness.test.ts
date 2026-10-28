// The Project preview harness, CSF stories and the Project's CSS, at the
// builder's boundary: a `component` source snapshots into `index.js` and
// `index.css`, read from a fake `files/v1` and compiled with the real esbuild
// and Tailwind compilers. (What the module renders when mounted is covered
// by `client/module-mount.test.ts`.)
//
// Contract matrix:
// - a harness that imports the Project's Tailwind v4 entry replaces Doric's
//   theme: the Project's own tokens and utilities, its `:root` rules as
//   written (the sheet is linked in the preview's own document), and none of
//   the generic theme's mapping;
// - without a harness, the generic theme is the base, with its own light
//   and dark tokens, never the app's;
// - the nearest harness wins, walking up from the previewed file, and
//   `.storybook/` wins over `.papercraft/` in the same directory;
// - a harness that cannot be bundled is left out with a warning naming the
//   import, and the preview still compiles;
// - a harness whose CSS is Tailwind v3 falls back to the generic theme,
//   warning;
// - a harness stylesheet named by a specifier the window import map would
//   serve (`desktop/ui/theme.css`) is compiled into `index.css`, never left
//   as an import in `index.js`;
// - a plain CSS file a component imports reaches `index.css`;
// - type-only `@storybook/*` imports erase, and `@storybook/addon-themes`
//   compiles without the Project having it;
// - a stories file mounts its first story by default, `entry` names
//   another, and an unknown story fails naming the stories.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import { compileComponent } from '../src/host/compile.js';
import { type PreviewSnapshot, snapshotPreview } from '../src/host/previews.js';
import { servicesFor, testCall } from './support/services.js';

/** `files/v1` over text files and, read as base64 only, binary ones. */
const filesService = (
  files: Record<string, string>,
  binaries: Record<string, Uint8Array> = {},
) => ({
  content: async ({
    path,
    encoding,
  }: {
    readonly path: string;
    readonly encoding?: 'utf8' | 'base64';
  }) => {
    const bytes =
      binaries[path] ??
      (files[path] === undefined ? undefined : Buffer.from(files[path]));
    if (bytes === undefined) {
      return { status: 'ready', value: { status: 'not_found' } };
    }
    const binary = path in binaries;

    return {
      status: 'ready',
      value: {
        status: 'read',
        path,
        content:
          encoding === 'base64'
            ? Buffer.from(bytes).toString('base64')
            : binary
              ? ''
              : files[path],
        truncated: false,
        binary,
      },
    };
  },
});

const snapshot = (
  files: Record<string, string>,
  path: string,
  entry?: string,
  binaries?: Record<string, Uint8Array>,
): Promise<PreviewSnapshot> =>
  snapshotPreview(
    servicesFor((id) => {
      if (id === 'files/v1') return filesService(files, binaries);
      throw new Error(`unexpected contract ${id}`);
    }),
    testCall,
    {
      source: 'component',
      path,
      ...(entry === undefined ? {} : { entry }),
    },
  );

const textOf = (built: PreviewSnapshot, path: string): string => {
  const file = built.files.find((candidate) => candidate.path === path);
  assert.ok(file !== undefined, `no ${path} in the snapshot`);

  return Buffer.from(file.base64, 'base64').toString('utf8');
};

const BADGE = [
  'export function Badge({ label }: { readonly label: string }) {',
  '  return <span className="bg-brand bg-primary p-2">{label}</span>;',
  '}',
].join('\n');

const BADGE_PREVIEW = [
  "import { Badge } from '../../../src/Badge.js';",
  'export default () => <Badge label="draft" />;',
].join('\n');

const PROJECT_CSS = [
  '@import "tailwindcss";',
  ':root { --brand: #123456; }',
  '.dark { --brand: #abcdef; }',
  '@theme inline { --color-brand: var(--brand); }',
].join('\n');

const harness = (marker: string, extra = ''): string =>
  [
    "import type { Preview } from '@storybook/react';",
    extra,
    'const preview: Preview = {',
    `  decorators: [(Story) => <div data-harness="${marker}"><Story /></div>],`,
    '};',
    'export default preview;',
  ].join('\n');

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

describe('the preview harness and the Project CSS', () => {
  test("a harness's Tailwind entry replaces the generic theme", async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        'src/index.css': PROJECT_CSS,
        '.papercraft/preview.tsx': harness(
          'root',
          "import '../src/index.css';",
        ),
        '.doric/artifacts/drafts/badge.tsx': BADGE_PREVIEW,
      },
      '.doric/artifacts/drafts/badge.tsx',
    );
    const css = textOf(built, 'index.css');

    assert.match(css, /\.bg-brand\s*\{[^}]*var\(--brand\)/);
    // The Project's `:root` tokens stay on `:root`, the preview document's.
    assert.match(css, /:root\s*\{\s*--brand:\s*#123456/);
    assert.doesNotMatch(css, /data-papercraft-theme/);
    // The generic mapping is not the base: the Project defines no `primary`.
    assert.doesNotMatch(css, /\.bg-primary\s*\{/);
    assert.match(textOf(built, 'index.js'), /data-harness/);
  });

  test("the fonts and images the Project's sheets name are stored with the preview", async () => {
    const font = Uint8Array.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]);
    const picture = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]);
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        'src/index.css': [
          '@import "tailwindcss";',
          '@import "./styles/fonts.css";',
          ':root { --brand: #123456; }',
          '.hero { background: url("/public/hero.png?v=2#top"); }',
        ].join('\n'),
        // Written for its own place, as `desktop/ui`'s faces are.
        'src/styles/fonts.css': [
          "@font-face { font-family: 'Face'; src: url('../../assets/fonts/face.woff2') format('woff2'); }",
          "@font-face { font-family: 'Face2'; src: url(../../assets/fonts/face.woff2); }",
          "@font-face { font-family: 'Gone'; src: url('./missing.woff2'); }",
          '.remote { background: url(https://example.com/a.png); }',
          '.inline { background: url("data:image/png;base64,AAAA"); }',
        ].join('\n'),
        '.papercraft/preview.tsx': harness(
          'root',
          "import '../src/index.css';",
        ),
        '.doric/artifacts/drafts/badge.tsx': BADGE_PREVIEW,
      },
      '.doric/artifacts/drafts/badge.tsx',
      undefined,
      {
        'assets/fonts/face.woff2': font,
        'public/hero.png': picture,
      },
    );
    const css = textOf(built, 'index.css');
    const stored = (bytes: Uint8Array, extension: string) => {
      const path = `assets/${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
      const file = built.files.find((candidate) => candidate.path === path);
      assert.ok(file !== undefined, `${path} is not stored with the preview`);
      assert.deepEqual(Buffer.from(file.base64, 'base64'), Buffer.from(bytes));
      assert.ok(built.entries.some((entry) => entry.path === path));
      return path;
    };

    const fontPath = stored(font, 'woff2');
    const picturePath = stored(picture, 'png');
    // One copy for a file named twice; every reference points at it.
    assert.equal(css.split(`url("./${fontPath}")`).length - 1, 2);
    assert.equal(
      built.files.filter((file) => file.path === fontPath).length,
      1,
    );
    assert.match(css, new RegExp(`url\\("\\./${picturePath}\\?v=2#top"\\)`));
    // What is not the Project's stays as written.
    assert.match(css, /url\(https:\/\/example\.com\/a\.png\)/);
    assert.match(css, /url\("data:image\/png;base64,AAAA"\)/);
    // A file that cannot be read keeps its reference, and the build says so.
    assert.match(css, /url\('\.\/missing\.woff2'\)/);
    assert.ok(
      built.warnings.some((warning) =>
        warning.includes('src/styles/missing.woff2'),
      ),
    );
    assert.doesNotMatch(css, /\.\.\/\.\.\/assets\/fonts/);
  });

  test('without a harness, the generic theme is the base, with its own tokens', async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        '.doric/artifacts/drafts/badge.tsx': BADGE_PREVIEW,
      },
      '.doric/artifacts/drafts/badge.tsx',
    );
    const css = textOf(built, 'index.css');

    assert.match(css, /\.bg-primary\s*\{[^}]*var\(--primary\)/);
    assert.doesNotMatch(css, /\.bg-brand\s*\{/);
    // The tokens are the theme's own, in light and dark, defined on the
    // preview document's root: nothing of the app's theme is provisioned.
    assert.match(css, /:root\s*\{[^}]*--primary:\s*oklch\(0\.205 0 0\)/);
    assert.match(css, /\.dark\s*\{[^}]*--primary:\s*oklch\(0\.922 0 0\)/);
  });

  test('the nearest harness wins, and .storybook over .papercraft', async () => {
    const files = {
      '.papercraft/preview.tsx': harness('root-papercraft'),
      'packages/web/.papercraft/preview.tsx': harness('web-papercraft'),
      'packages/web/.storybook/preview.tsx': harness('web-storybook'),
      'packages/web/src/Badge.tsx': BADGE,
    };
    const js = textOf(
      await snapshot(files, 'packages/web/src/Badge.tsx'),
      'index.js',
    );

    assert.match(js, /web-storybook/);
    assert.doesNotMatch(js, /web-papercraft|root-papercraft/);

    const draft = textOf(
      await snapshot(
        {
          ...files,
          '.doric/artifacts/drafts/badge.tsx':
            'import { Badge } from \'../../../packages/web/src/Badge.js\';\nexport default () => <Badge label="x" />;',
        },
        '.doric/artifacts/drafts/badge.tsx',
      ),
      'index.js',
    );

    assert.match(draft, /root-papercraft/);
  });

  test('a harness that cannot be bundled is left out, with a warning', async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        '.storybook/preview.tsx': harness(
          'broken',
          "import { initialize } from 'msw-storybook-addon';\ninitialize();",
        ),
      },
      'src/Badge.tsx',
    );

    assert.doesNotMatch(textOf(built, 'index.js'), /data-harness/);
    assert.ok(
      built.warnings.some(
        (warning) =>
          warning.includes('.storybook/preview.tsx') &&
          warning.includes('msw-storybook-addon'),
      ),
      built.warnings.join('\n'),
    );
  });

  test('a Tailwind v3 global sheet falls back to the generic theme', async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        'src/globals.css':
          '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n:root { --brand: 1 2 3; }',
        '.storybook/preview.tsx': harness('v3', "import '../src/globals.css';"),
      },
      'src/Badge.tsx',
    );

    assert.match(
      textOf(built, 'index.css'),
      /\.bg-primary\s*\{[^}]*var\(--primary\)/,
    );
    assert.ok(
      built.warnings.some((warning) => /Tailwind v3/.test(warning)),
      built.warnings.join('\n'),
    );
  });

  test('a harness stylesheet the import map would serve reaches the sheet, not the module', async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        'node_modules/desktop/package.json': JSON.stringify({
          name: 'desktop',
          exports: { './ui/theme.css': './src/theme.css' },
        }),
        'node_modules/desktop/src/theme.css': PROJECT_CSS,
        '.storybook/preview.tsx': harness(
          'theme',
          "import 'desktop/ui/theme.css';",
        ),
      },
      'src/Badge.tsx',
    );

    assert.match(textOf(built, 'index.css'), /:root\s*\{\s*--brand:\s*#123456/);
    // A window cannot import a stylesheet as a module: it would fail the load.
    assert.doesNotMatch(textOf(built, 'index.js'), /theme\.css/);
  });

  test("a component's plain CSS import reaches the sheet", async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': `import './badge.css';\n${BADGE}`,
        'src/badge.css': '.badge-ring { outline: 3px solid tomato; }',
      },
      'src/Badge.tsx',
    );

    assert.match(
      textOf(built, 'index.css'),
      /\.badge-ring\s*\{\s*outline:\s*3px solid tomato/,
    );
  });

  test('@storybook/addon-themes compiles without the Project having it', async () => {
    const built = await snapshot(
      {
        'src/Badge.tsx': BADGE,
        '.storybook/preview.tsx': [
          "import type { Preview } from '@storybook/react-vite';",
          "import { withThemeByClassName } from '@storybook/addon-themes';",
          'export const decorators = [',
          "  withThemeByClassName({ themes: { light: '', dark: 'dark' }, defaultTheme: 'light' }),",
          '];',
          'export default {} satisfies Preview;',
        ].join('\n'),
      },
      'src/Badge.tsx',
    );

    assert.deepEqual(built.warnings, []);
  });
});

describe('CSF stories', () => {
  const STORIES = [
    "import type { Meta, StoryObj } from '@storybook/react';",
    "import { Badge } from './Badge.js';",
    'const meta = { component: Badge, args: { label: "meta" } } satisfies Meta<typeof Badge>;',
    'export default meta;',
    'type Story = StoryObj<typeof meta>;',
    "export const Secondary: Story = { args: { label: 'second' } };",
    "export const Primary: Story = { args: { label: 'first' } };",
  ].join('\n');

  const files = {
    'src/Badge.tsx': BADGE,
    'src/Badge.stories.tsx': STORIES,
  };

  const compileFrom = (entry?: string) =>
    compileComponent(async (path) => files[path as keyof typeof files], {
      path: 'src/Badge.stories.tsx',
      ...(entry === undefined ? {} : { entry }),
    });

  test('a stories file mounts its first story; entry names another', async () => {
    assert.equal((await compileFrom()).exportName, 'Secondary');
    assert.equal((await compileFrom('Primary')).exportName, 'Primary');
  });

  test('an unknown story fails naming the stories', async () => {
    await rejectsWith(
      snapshot(files, 'src/Badge.stories.tsx', 'Missing'),
      /no story "Missing".*Secondary, Primary/,
    );
  });
});
