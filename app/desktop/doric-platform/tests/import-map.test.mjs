import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const project = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(project, '../../..');
const assets = join(
  workspace,
  process.env.DORIC_PLATFORM_ASSETS ?? 'dist/app/desktop/doric/assets',
);
const platform = join(assets, 'platform');
const prefix = 'doric://app/platform/';

const { imports } = JSON.parse(
  readFileSync(join(platform, 'importmap.platform.json'), 'utf8'),
);

const filesUnder = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const emittedScripts = filesUnder(platform).filter((path) =>
  path.endsWith('.js'),
);

const bareImports = (source) =>
  [...source.matchAll(/(?:\bfrom|\bimport)\s*["']([^"'./][^"']*)["']/g)].map(
    (match) => match[1],
  );

const manifest = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('the platform import map', () => {
  test('points every specifier at a file the build emitted', () => {
    for (const [specifier, target] of Object.entries(imports)) {
      assert.ok(target.startsWith(prefix), `${specifier} → ${target}`);
      const path = join(platform, target.slice(prefix.length));
      if (specifier.endsWith('/')) {
        assert.ok(statSync(path).isDirectory(), `${specifier} → ${target}`);
      } else {
        assert.ok(existsSync(path), `${specifier} → ${target} is missing`);
      }
    }
  });

  test('serves exactly React, ReactDOM, Lexical, Base UI, desktop/ui, zod and bundle/contracts', () => {
    const roots = new Set(
      Object.keys(imports).map((specifier) => {
        const parts = specifier.split('/');
        return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      }),
    );
    for (const root of roots) {
      assert.ok(
        [
          'react',
          'react-dom',
          'lexical',
          '@base-ui/react',
          'desktop',
          'zod',
          'bundle',
        ].includes(root) || root.startsWith('@lexical/'),
        `unexpected platform package ${root}`,
      );
    }
    for (const specifier of [
      'react',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'react-dom',
      'react-dom/client',
      'lexical',
      '@base-ui/react',
      '@base-ui/react/popover',
      '@base-ui/react/use-render',
      '@base-ui/react/merge-props',
      'zod',
      'bundle/contracts',
      'desktop/ui',
      'desktop/ui/',
    ]) {
      assert.ok(specifier in imports, `${specifier} is not mapped`);
    }
    for (const removed of [
      'radix-ui',
      'lucide-react',
      '@tanstack/react-query',
      'desktop/client',
      'desktop/protocol',
      'desktop/reads',
    ]) {
      assert.equal(imports[removed], undefined);
    }
  });

  test('names third-party folders by npm version and platform folders by PLATFORM_VERSION', () => {
    const version = (name) =>
      manifest(join(workspace, 'node_modules', name, 'package.json')).version;
    assert.equal(imports.react, `${prefix}react@${version('react')}/index.js`);
    assert.equal(
      imports['react-dom/client'],
      `${prefix}react-dom@${version('react-dom')}/client.js`,
    );
    assert.equal(
      imports.lexical,
      `${prefix}lexical@${version('lexical')}/index.js`,
    );
    assert.equal(imports.zod, `${prefix}zod@${version('zod')}/index.js`);
    assert.equal(
      imports['@base-ui/react/popover'],
      `${prefix}@base-ui/react@${version('@base-ui/react')}/popover.js`,
    );
    assert.equal(
      imports['bundle/contracts'],
      `${prefix}bundle@1.0.0/contracts.js`,
    );
    assert.equal(imports['desktop/ui/'], `${prefix}desktop@1.0.0/`);
  });

  test('maps every Lexical specifier the client bundles import', () => {
    const clients = join(workspace, 'bundles/desktop/chat/src/client');
    const used = new Set(
      filesUnder(clients)
        .filter((path) => /\.tsx?$/.test(path))
        .flatMap((path) => bareImports(readFileSync(path, 'utf8')))
        .filter(
          (specifier) =>
            specifier === 'lexical' || specifier.startsWith('@lexical/'),
        ),
    );
    assert.ok(used.size > 0);
    for (const specifier of used) {
      assert.ok(
        specifier in imports,
        `client import ${specifier} is not mapped`,
      );
    }
    const dependencies = Object.keys(
      manifest(join(workspace, 'bundles/desktop/chat/package.json'))
        .dependencies,
    ).filter((name) => name === 'lexical' || name.startsWith('@lexical/'));
    for (const name of dependencies) {
      // Some packages (`@lexical/react`) export subpaths only, no root.
      assert.ok(
        Object.keys(imports).some(
          (key) => key === name || key.startsWith(`${name}/`),
        ),
        `${name} is not mapped`,
      );
    }
  });

  test('maps every Base UI specifier desktop/ui and the client bundles import', () => {
    const bundles = join(workspace, 'bundles');
    const sources = [
      join(workspace, 'packages/desktop/src'),
      ...readdirSync(bundles)
        .flatMap((group) =>
          statSync(join(bundles, group)).isDirectory()
            ? readdirSync(join(bundles, group)).map((name) =>
                join(bundles, group, name, 'src/client'),
              )
            : [],
        )
        .filter((dir) => existsSync(dir)),
    ];
    const used = new Set(
      sources
        .flatMap((dir) => filesUnder(dir))
        .filter((path) => /\.tsx?$/.test(path))
        .flatMap((path) => bareImports(readFileSync(path, 'utf8')))
        .filter(
          (specifier) =>
            specifier === '@base-ui/react' ||
            specifier.startsWith('@base-ui/react/'),
        ),
    );
    assert.ok(used.size > 0);
    for (const specifier of used) {
      assert.ok(specifier in imports, `${specifier} is not mapped`);
    }
  });

  test('serves every subpath Base UI exports but one whose code needs a package the workspace does not install', async () => {
    const exported = Object.keys(
      manifest(join(workspace, 'node_modules/@base-ui/react/package.json'))
        .exports,
    )
      .filter((key) => key !== './package.json')
      .map((key) =>
        key === '.' ? '@base-ui/react' : `@base-ui/react/${key.slice(2)}`,
      );
    for (const specifier of exported.filter((name) => !(name in imports))) {
      await assert.rejects(
        esbuild.build({
          entryPoints: [specifier],
          absWorkingDir: workspace,
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'browser',
          external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
          logLevel: 'silent',
        }),
        /Could not resolve/,
        `${specifier} is buildable but not mapped`,
      );
    }
  });

  test('maps every desktop/ui component by its own explicit entry', () => {
    const components = readdirSync(
      join(workspace, 'packages/desktop/src/components'),
    )
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => name.slice(0, -'.tsx'.length));
    assert.equal(components.length, 34);
    for (const name of [
      ...components,
      'chrome-bar',
      'react-element',
      'utils',
      'tokens',
    ]) {
      assert.equal(
        imports[`desktop/ui/${name}`],
        `${prefix}desktop@1.0.0/${name}.js`,
      );
    }
  });

  test('leaves no emitted file importing a package the map does not serve', async () => {
    // esbuild parses every emitted file; each bare import it meets is recorded.
    const unmapped = [];
    await esbuild.build({
      entryPoints: emittedScripts,
      bundle: true,
      write: false,
      format: 'esm',
      splitting: true,
      outdir: join(project, 'unused'),
      logLevel: 'silent',
      plugins: [
        {
          name: 'collect-bare-imports',
          setup(build) {
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              if (args.kind === 'entry-point') return undefined;
              if (!(args.path in imports)) {
                unmapped.push(
                  `${relative(platform, args.importer)} imports ${args.path}`,
                );
              }
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    assert.deepEqual(unmapped, []);
  });
});

describe('the React build', () => {
  test('keeps react-dom importing react statically, never through require', () => {
    const reactDom = dirname(
      join(platform, imports['react-dom'].slice(prefix.length)),
    );
    const sources = filesUnder(reactDom)
      .filter((path) => path.endsWith('.js'))
      .map((path) => readFileSync(path, 'utf8'));
    assert.ok(sources.some((source) => bareImports(source).includes('react')));
    const client = readFileSync(join(reactDom, 'client.js'), 'utf8');
    assert.ok(bareImports(client).includes('react-dom'));
    for (const source of sources) {
      assert.doesNotMatch(source, /__require\(\s*["']react(-dom)?["']\s*\)/);
    }
  });
});

describe('a window module loaded through the map', () => {
  const report = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(project, 'tests/fixtures/apply-import-map.mjs'),
        platform,
        join(project, 'tests/fixtures/window-modules.mjs'),
      ],
      { encoding: 'utf8' },
    ),
  );

  test('renders a desktop/ui Button from a component using hooks, so one React instance serves both', () => {
    assert.match(report.button, /^<button\b[^>]*\bdata-slot="button"/);
    assert.match(report.button, />Count 3<\/button>$/);
  });

  test('shares one Base UI between the module and desktop/ui: a desktop/ui Toggle reads the group the module renders', () => {
    assert.deepEqual(
      [...report.toggles.matchAll(/aria-pressed="(true|false)"/g)].map(
        (match) => match[1],
      ),
      ['true', 'false'],
    );
  });

  test('runs Lexical and the React composer context against the same lexical instance', () => {
    assert.equal(report.rootType, 'root');
    assert.equal(report.composer, '<span>function</span>');
  });

  test('loads zod, bundle/contracts and react-dom/client', () => {
    assert.equal(report.zod, true);
    assert.equal(report.contractError, 'function');
    assert.equal(report.createRoot, 'function');
  });
});

describe('the desktop/ui stylesheet', () => {
  const folder = join(platform, 'desktop@1.0.0');
  const theme = readFileSync(join(folder, 'theme.css'), 'utf8');

  test('resolves every url() to a font the build copied', () => {
    const urls = [...theme.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(
      (match) => match[1],
    );
    assert.equal(urls.filter((url) => url.startsWith('fonts/')).length, 12);
    for (const url of urls.filter((url) => !url.startsWith('data:'))) {
      assert.ok(existsSync(join(folder, url)), `${url} is missing`);
    }
  });

  test('carries the faces, the tokens, the chrome bar rule and component utilities', () => {
    // The twelve app faces, and the codicon face Monaco's stylesheet brings.
    assert.equal(theme.match(/@font-face/g)?.length, 13);
    assert.match(theme, /font-family:\s*["']?codicon/);
    assert.match(
      theme,
      /\.chrome-bar\s*\{\s*height:\s*var\(--doric-titlebar-height\)/,
    );
    assert.match(theme, /--doric-safe-right/);
    assert.match(theme, /\.bg-secondary\b/);
  });

  test('carries the editor stylesheet and serves its worker beside the files', () => {
    assert.match(theme, /\.monaco-editor\b/);
    assert.ok(existsSync(join(folder, 'workers', 'editor.worker.js')));
    assert.equal(
      readdirSync(folder)
        .filter((name) => name.endsWith('.css'))
        .join(),
      'theme.css',
    );
  });

  test('ships the tokens and every license next to the files', () => {
    assert.deepEqual(
      manifest(join(folder, 'tokens.json')),
      manifest(join(workspace, 'packages/desktop/dist/tokens.json')),
    );
    for (const name of ['NotoSans-OFL.txt', 'IBMPlexMono-OFL.txt']) {
      assert.ok(existsSync(join(folder, 'fonts', name)));
    }
    assert.ok(existsSync(join(folder, 'licenses')));
    assert.ok(
      existsSync(
        join(platform, imports.react.slice(prefix.length), '../LICENSE'),
      ),
    );
  });
});

describe('the schemas', () => {
  test('copies packages/bundle/dist/schemas byte for byte', () => {
    const source = join(workspace, 'packages/bundle/dist/schemas');
    const target = join(assets, 'schemas');
    const list = (dir) =>
      filesUnder(dir)
        .map((path) => relative(dir, path))
        .sort();
    assert.deepEqual(list(target), list(source));
    for (const path of list(source)) {
      assert.ok(
        readFileSync(join(source, path)).equals(
          readFileSync(join(target, path)),
        ),
      );
    }
  });
});
