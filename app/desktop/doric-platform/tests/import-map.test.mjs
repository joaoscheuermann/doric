import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PLATFORM_ASSETS_VERSION } from 'bundle/runtime';
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

  test('serves exactly React, ReactDOM, Lexical, Base UI, desktop/ui, zod, @bufbuild/protobuf, @connectrpc/connect, bundle/contracts and bundle/client', () => {
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
          '@bufbuild/protobuf',
          '@connectrpc/connect',
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

  test('names third-party folders by npm version and platform folders by PLATFORM_ASSETS_VERSION', () => {
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
      `${prefix}bundle@${PLATFORM_ASSETS_VERSION}/contracts.js`,
    );
    assert.equal(
      imports['desktop/ui/'],
      `${prefix}desktop@${PLATFORM_ASSETS_VERSION}/`,
    );
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
    assert.equal(components.length, 37);
    for (const name of [
      ...components,
      'chrome-bar',
      'element-host',
      'error-notice',
      'model-icon',
      'choice-list',
      'collapsible-block',
      'react-element',
      'utils',
      'tokens',
    ]) {
      assert.equal(
        imports[`desktop/ui/${name}`],
        `${prefix}desktop@${PLATFORM_ASSETS_VERSION}/${name}.js`,
      );
    }
  });

  test('maps the identity mark and the reader avatar by their own entries', () => {
    assert.equal(
      imports['desktop/ui/identity'],
      `${prefix}desktop@${PLATFORM_ASSETS_VERSION}/identity.js`,
    );
    assert.equal(
      imports['desktop/ui/reader-avatar'],
      `${prefix}desktop@${PLATFORM_ASSETS_VERSION}/reader-avatar.js`,
    );
  });

  test('serves the identity mark without any package, so a React-free importer loads no React', async () => {
    const identity = join(
      platform,
      `desktop@${PLATFORM_ASSETS_VERSION}`,
      'identity.js',
    );
    assert.ok(existsSync(identity), `${identity} is missing`);
    // esbuild follows identity.js and its relative chunks; each bare import is recorded.
    const bare = [];
    await esbuild.build({
      entryPoints: [identity],
      bundle: true,
      write: false,
      format: 'esm',
      logLevel: 'silent',
      plugins: [
        {
          name: 'collect-bare-imports',
          setup(build) {
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              if (args.kind === 'entry-point') return undefined;
              bare.push(
                `${relative(platform, args.importer)} imports ${args.path}`,
              );
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    assert.deepEqual(bare, []);
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

// T3.14 (AC3.15, A53): `bundle`'s generated code and `@bufbuild/protobuf`
// are served once per window through the map.
describe('the generated code in the platform map', () => {
  const bundleFolder = join(platform, `bundle@${PLATFORM_ASSETS_VERSION}`);
  const generatedSources = join(workspace, 'packages/bundle/src/contracts/gen');
  const generatedPaths = filesUnder(generatedSources)
    .filter((path) => path.endsWith('_pb.ts'))
    .map((path) =>
      relative(generatedSources, path)
        .split(/[\\/]/)
        .join('/')
        .replace(/\.ts$/, '.js'),
    );
  const emittedUnder = (dir) =>
    existsSync(dir) ? filesUnder(dir).filter((path) => path.endsWith('.js')) : [];

  test('maps bundle/contracts/gen/<path>_pb.js for every generated file of bundle, and nothing else under that prefix', () => {
    assert.ok(generatedPaths.includes('doric/platform/v1/options_pb.js'));
    assert.ok(generatedPaths.includes('buf/validate/validate_pb.js'));
    assert.ok(generatedPaths.includes('google/rpc/status_pb.js'));
    assert.equal(
      imports['bundle/contracts/gen/doric/platform/v1/options_pb.js'],
      `${prefix}bundle@${PLATFORM_ASSETS_VERSION}/contracts/gen/doric/platform/v1/options_pb.js`,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(imports).filter(([specifier]) =>
          specifier.startsWith('bundle/contracts/gen/'),
        ),
      ),
      Object.fromEntries(
        generatedPaths.map((path) => [
          `bundle/contracts/gen/${path}`,
          `${prefix}bundle@${PLATFORM_ASSETS_VERSION}/contracts/gen/${path}`,
        ]),
      ),
    );
  });

  test('serves @bufbuild/protobuf, its codegenv2 and its wkt by npm version', () => {
    const version = manifest(
      join(workspace, 'node_modules/@bufbuild/protobuf/package.json'),
    ).version;
    const folder = `${prefix}@bufbuild/protobuf@${version}`;
    assert.equal(imports['@bufbuild/protobuf'], `${folder}/index.js`);
    assert.equal(
      imports['@bufbuild/protobuf/codegenv2'],
      `${folder}/codegenv2.js`,
    );
    assert.equal(imports['@bufbuild/protobuf/wkt'], `${folder}/wkt.js`);
  });

  test('serves bundle/client in the platform folder and @connectrpc/connect by npm version (S64)', () => {
    const version = manifest(
      join(workspace, 'node_modules/@connectrpc/connect/package.json'),
    ).version;

    assert.ok(
      imports['bundle/client']?.startsWith(
        `${prefix}bundle@${PLATFORM_ASSETS_VERSION}/`,
      ),
      `bundle/client → ${imports['bundle/client']}`,
    );
    assert.ok(
      imports['@connectrpc/connect']?.startsWith(
        `${prefix}@connectrpc/connect@${version}/`,
      ),
      `@connectrpc/connect → ${imports['@connectrpc/connect']}`,
    );
  });

  test('leaves every generated file importing only mapped bundle/contracts/gen/… and @bufbuild/protobuf specifiers', () => {
    const emitted = emittedUnder(join(bundleFolder, 'contracts', 'gen'));
    assert.ok(emitted.length > 0, 'no generated file was emitted');
    const wrong = emitted.flatMap((path) =>
      bareImports(readFileSync(path, 'utf8'))
        .filter(
          (specifier) =>
            !(specifier in imports) ||
            !(
              specifier.startsWith('bundle/contracts/gen/') ||
              specifier === '@bufbuild/protobuf' ||
              specifier.startsWith('@bufbuild/protobuf/')
            ),
        )
        .map((specifier) => `${relative(platform, path)} imports ${specifier}`),
    );
    assert.deepEqual(wrong, []);
  });

  test('leaves @bufbuild/protobuf to the map in contracts.js', async () => {
    // esbuild follows contracts.js and its relative chunks; each bare import is recorded.
    const bare = new Set();
    await esbuild.build({
      entryPoints: [join(bundleFolder, 'contracts.js')],
      bundle: true,
      write: false,
      format: 'esm',
      logLevel: 'silent',
      plugins: [
        {
          name: 'collect-bare-imports',
          setup(build) {
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              if (args.kind === 'entry-point') return undefined;
              bare.add(args.path);
              return { path: args.path, external: true };
            });
          },
        },
      ],
    });
    assert.ok(
      bare.has('@bufbuild/protobuf'),
      `contracts.js bundles @bufbuild/protobuf; it imports only ${[...bare].join(', ')}`,
    );
  });

  test('emits each generated descriptor in exactly one file, so contracts.js and the generated entries share it', () => {
    const emitted = emittedUnder(platform).map((path) => ({
      path,
      source: readFileSync(path, 'utf8'),
    }));
    const counts = generatedPaths.map((path) => {
      const source = readFileSync(
        join(generatedSources, path.replace(/\.js$/, '.ts')),
        'utf8',
      );
      const descriptor = /fileDesc\(\s*"([^"]+)"/.exec(source)?.[1];
      assert.ok(descriptor !== undefined, `${path} has no descriptor`);
      return [
        path,
        emitted.filter((file) => file.source.includes(descriptor)).length,
      ];
    });
    assert.deepEqual(
      counts.filter(([, count]) => count !== 1),
      [],
    );
  });

  test('loads generated code, bundle/contracts and @bufbuild/protobuf through the map as one instance', () => {
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(project, 'tests/fixtures/apply-import-map.mjs'),
          platform,
          join(project, 'tests/fixtures/generated-modules.mjs'),
        ],
        { encoding: 'utf8' },
      ),
    );
    const base = `${pathToFileURL(platform).href}/`;
    for (const [specifier, url] of Object.entries(report.resolved)) {
      assert.ok(specifier in imports, `${specifier} is not mapped`);
      assert.equal(url, imports[specifier].replace(prefix, base), specifier);
    }
    assert.equal(report.fileDesc, 'function');
    assert.equal(report.controlDependsOnStatus, true);
    assert.equal(report.statusIsMessage, true);
    assert.equal(report.contractsStatusIsMessage, true);
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
  const folder = join(platform, `desktop@${PLATFORM_ASSETS_VERSION}`);
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
