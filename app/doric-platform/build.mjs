/**
 * Builds the shared platform packages every desktop window loads once, as
 * browser ESM under `<out>/platform/`, writes `importmap.platform.json` from
 * the files actually emitted, and copies the bundle JSON schemas to
 * `<out>/schemas/`.
 *
 *   node app/doric-platform/build.mjs --out dist/app/doric/assets [--mode production|development]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { PLATFORM_VERSION } from 'bundle/runtime';
import * as esbuild from 'esbuild';

import {
  bundleContracts,
  desktopUi,
  esmPackages,
  lexicalRoots,
  platformUrl,
  react,
  schemas,
} from './packages.config.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(workspace, 'package.json'));

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'dist/app/doric/assets' },
    mode: { type: 'string' },
  },
});
const mode =
  values.mode ??
  (process.env.NODE_ENV === 'development' ? 'development' : 'production');

if (mode !== 'production' && mode !== 'development') {
  throw new Error(`Unknown mode ${mode}; use production or development.`);
}

const out = resolve(workspace, values.out);
const platformOut = join(out, 'platform');

/** Hoisted install folder (some packages do not export `./package.json`). */
const packageDir = (name) => {
  const dir = join(workspace, 'node_modules', name);
  if (!existsSync(join(dir, 'package.json'))) {
    throw new Error(`${name} is not installed in the workspace root.`);
  }
  return dir;
};
const packageJson = (name) =>
  JSON.parse(readFileSync(join(packageDir(name), 'package.json'), 'utf8'));
const folder = (name, version) => `${name}@${version}`;

/**
 * One served group: one esbuild call, one folder. `entries` maps each import
 * specifier to the file it is served as inside the folder.
 */
const groups = [];

// React and ReactDOM.
for (const name of ['react', 'react-dom']) {
  groups.push({
    kind: 'cjs',
    package: name,
    dir: folder(name, packageJson(name).version),
    entries: react
      .filter((entry) => entry.package === name)
      .map((entry) => ({
        specifier: entry.specifier,
        file: entry.file,
        source: require.resolve(entry.specifier),
      })),
  });
}

// Lexical: the renderer's packages and every @lexical/* they depend on.
const lexical = [];
const pending = [...lexicalRoots];
while (pending.length > 0) {
  const name = pending.shift();
  if (lexical.includes(name)) continue;
  lexical.push(name);
  for (const dependency of Object.keys(packageJson(name).dependencies ?? {})) {
    if (dependency === 'lexical' || dependency.startsWith('@lexical/')) {
      pending.push(dependency);
    }
  }
}

/** The bare-specifier subpaths a package exports, wildcards expanded. */
const exportedSubpaths = (name) => {
  const manifest = packageJson(name);
  const keys = Object.keys(manifest.exports ?? { '.': manifest.module });
  const subpaths = [];
  for (const key of keys) {
    if (key === './package.json') continue;
    if (!key.includes('*')) {
      subpaths.push(key);
      continue;
    }
    const target = conditionTarget(manifest.exports[key]);
    const [prefix, suffix] = target.split('*');
    const [keyPrefix, keySuffix] = key.split('*');
    const dir = join(packageDir(name), prefix);
    for (const file of readdirSync(dir)) {
      if (!statSync(join(dir, file)).isFile()) continue;
      if (suffix === '' ? !file.endsWith('.js') : !file.endsWith(suffix)) {
        continue;
      }
      const stem = suffix === '' ? file : file.slice(0, -suffix.length);
      subpaths.push(`${keyPrefix}${stem}${keySuffix}`);
    }
  }
  return subpaths;
};

const conditionTarget = (value) => {
  if (typeof value === 'string') return value;
  for (const condition of [mode, 'import', 'default']) {
    if (condition in value) return conditionTarget(value[condition]);
  }
  throw new Error(`No import target in ${JSON.stringify(value)}`);
};

/** Out file for a subpath: `.` is `index.js`; a `./x.js` twin of `./x` aliases it. */
const esmGroup = (name) => {
  const subpaths = exportedSubpaths(name);
  const entries = subpaths.map((subpath) => {
    const bare = subpath === '.' ? 'index' : subpath.slice(2);
    const stem =
      bare.endsWith('.js') && subpaths.includes(subpath.slice(0, -3))
        ? bare.slice(0, -3)
        : bare.replace(/\.js$/, '');
    return {
      specifier: subpath === '.' ? name : `${name}/${subpath.slice(2)}`,
      file: `${stem}.js`,
      source: subpath === '.' ? name : `${name}/${subpath.slice(2)}`,
    };
  });
  return {
    kind: 'esm',
    package: name,
    dir: folder(name, packageJson(name).version),
    entries,
  };
};

for (const name of lexical) groups.push(esmGroup(name));
for (const name of esmPackages) groups.push(esmGroup(name));

groups.push({
  kind: 'contracts',
  package: bundleContracts.package,
  dir: folder(bundleContracts.package, PLATFORM_VERSION),
  entries: [
    {
      specifier: bundleContracts.specifier,
      file: bundleContracts.file,
      source: join(workspace, bundleContracts.source),
    },
  ],
});

// desktop-ui: every code subpath of its export map (CSS and JSON excluded).
const desktopUiRoot = join(workspace, desktopUi.root);
const desktopUiManifest = JSON.parse(
  readFileSync(join(desktopUiRoot, 'package.json'), 'utf8'),
);
const desktopUiEntries = [];
for (const [key, value] of Object.entries(desktopUiManifest.exports)) {
  if (typeof value === 'string') continue;
  const source = value['@org/source'];
  if (!key.includes('*')) {
    const bare = key === '.' ? 'index' : key.slice(2);
    desktopUiEntries.push({
      specifier: key === '.' ? 'desktop-ui' : `desktop-ui/${bare}`,
      file: `${bare}.js`,
      source: join(desktopUiRoot, source),
    });
    continue;
  }
  const [prefix, suffix] = source.split('*');
  const [keyPrefix] = key.split('*');
  const dir = join(desktopUiRoot, prefix);
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(suffix)) continue;
    const stem = file.slice(0, -suffix.length);
    const bare = `${keyPrefix.slice(2)}${stem}`;
    desktopUiEntries.push({
      specifier: `desktop-ui/${bare}`,
      file: `${bare}.js`,
      source: join(dir, file),
    });
  }
}
groups.push({
  kind: 'desktop-ui',
  package: desktopUi.package,
  dir: folder(desktopUi.package, PLATFORM_VERSION),
  entries: desktopUiEntries,
});

for (const group of groups) {
  const files = new Set();
  for (const entry of group.entries) {
    if (files.has(entry.file) && !entry.specifier.endsWith('.js')) {
      throw new Error(`${group.dir}: two entries emit ${entry.file}.`);
    }
    files.add(entry.file);
  }
}

/** Every specifier the import map serves: external to every other build. */
const platformSpecifiers = new Set(
  groups.flatMap((group) => group.entries.map((entry) => entry.specifier)),
);

const isBare = (path) => !/^(\.|\/|[a-zA-Z]:[\\/]|node:)/.test(path);

/**
 * Keeps every platform specifier a static external import. A CommonJS
 * `require('react')` inside react-dom becomes a virtual ESM module that
 * imports `react`, since esbuild cannot turn an external `require` into an
 * import on its own.
 */
const platformExternals = {
  name: 'platform-externals',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point' || !isBare(args.path)) return undefined;
      if (!platformSpecifiers.has(args.path)) return undefined;
      if (args.kind === 'require-call') {
        return { path: args.path, namespace: 'cjs-external-interop' };
      }
      return { path: args.path, external: true };
    });
    build.onLoad(
      { filter: /.*/, namespace: 'cjs-external-interop' },
      (args) => ({
        contents: `import * as ns from ${JSON.stringify(args.path)};\nexport default ns;\nexport * from ${JSON.stringify(args.path)};\n`,
        loader: 'js',
        resolveDir: workspace,
      }),
    );
  },
};

/** The CommonJS module's export names, evaluated in the build's mode. */
const cjsNames = (source) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  try {
    return Object.keys(require(source)).filter(
      (name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name),
    );
  } finally {
    process.env.NODE_ENV = previous;
  }
};

const cjsEntry = {
  name: 'cjs-entry',
  setup(build) {
    build.onResolve({ filter: /^cjs-entry:/ }, (args) => ({
      path: args.path.slice('cjs-entry:'.length),
      namespace: 'cjs-entry',
    }));
    build.onLoad({ filter: /.*/, namespace: 'cjs-entry' }, (args) => {
      const names = cjsNames(args.path);
      return {
        contents: `import m from ${JSON.stringify(args.path)};\nexport const { ${names.join(', ')} } = m;\nexport default m;\n`,
        loader: 'js',
        resolveDir: dirname(args.path),
      };
    });
  },
};

const common = {
  bundle: true,
  format: 'esm',
  splitting: true,
  write: true,
  metafile: true,
  minify: mode === 'production',
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: workspace,
  target: 'es2022',
  conditions: [mode, 'module'],
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
  chunkNames: 'chunk-[hash]',
  entryNames: '[dir]/[name]',
};

/** The installed package folder a `node_modules/<pkg>/...` input belongs to. */
const inputPackage = (input) => {
  const path = input.replaceAll('\\', '/');
  const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(path);
  return match === null
    ? undefined
    : { name: match[2], dir: resolve(workspace, match[1]) };
};

const licenseFile = (dir) =>
  ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']
    .map((name) => join(dir, name))
    .find((path) => existsSync(path));

/**
 * Each folder carries its package's license as `LICENSE` and, under
 * `licenses/`, the license of every package bundled into its files. A bundled
 * package that ships no license file is recorded by its manifest's `license`.
 */
const copyLicenses = async (group, metafile) => {
  const target = join(platformOut, group.dir);
  const own = licenseFile(
    group.kind === 'contracts' || group.kind === 'desktop-ui'
      ? join(workspace, 'packages', group.package)
      : packageDir(group.package),
  );
  if (own !== undefined) await cp(own, join(target, 'LICENSE'));
  const bundled = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const found = inputPackage(input);
    if (found !== undefined && found.name !== group.package) {
      bundled.set(found.dir, found.name);
    }
  }
  if (bundled.size === 0) return;
  await mkdir(join(target, 'licenses'), { recursive: true });
  for (const [dir, name] of [...bundled].sort(([, a], [, b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const manifest = JSON.parse(
      readFileSync(join(dir, 'package.json'), 'utf8'),
    );
    const file = join(
      target,
      'licenses',
      `${name.replace('/', '__')}@${manifest.version}.txt`,
    );
    const license = licenseFile(dir);
    if (license !== undefined) {
      await cp(license, file);
    } else {
      await writeFile(
        file,
        `${name}@${manifest.version}\nLicense: ${manifest.license ?? 'UNKNOWN'} (the package ships no license file)\n`,
      );
    }
  }
};

const buildGroup = async (group) => {
  const outdir = join(platformOut, group.dir);
  const entryPoints = group.entries
    .filter(
      (entry, index, all) =>
        all.findIndex((other) => other.file === entry.file) === index,
    )
    .map((entry) => ({
      in: group.kind === 'cjs' ? `cjs-entry:${entry.source}` : entry.source,
      out: entry.file.slice(0, -'.js'.length),
    }));
  const result = await esbuild.build({
    ...common,
    entryPoints,
    outdir,
    platform: group.kind === 'contracts' ? 'neutral' : 'browser',
    mainFields: group.kind === 'contracts' ? [] : ['browser', 'module', 'main'],
    jsx: 'automatic',
    plugins: [platformExternals, cjsEntry],
  });
  const emitted = new Set(
    Object.keys(result.metafile.outputs).map((path) =>
      relative(outdir, resolve(workspace, path)).replaceAll('\\', '/'),
    ),
  );
  await copyLicenses(group, result.metafile);
  return emitted;
};

const buildTheme = async () => {
  const source = join(workspace, desktopUi.theme);
  const base = dirname(source);
  const compiler = await compile(await readFile(source, 'utf8'), {
    base,
    from: source,
    onDependency: () => undefined,
  });
  const sources = [
    ...(compiler.root === null
      ? [{ base, pattern: '**/*', negated: false }]
      : compiler.root === 'none'
        ? []
        : [{ ...compiler.root, negated: false }]),
    ...compiler.sources,
  ];
  const css = compiler
    .build(new Scanner({ sources }).scan())
    .replaceAll(desktopUi.fontsUrlPrefix, 'fonts/');
  const target = join(platformOut, folder(desktopUi.package, PLATFORM_VERSION));
  await writeFile(join(target, 'theme.css'), css);
  await cp(join(workspace, desktopUi.fonts), join(target, 'fonts'), {
    recursive: true,
  });
  await cp(join(workspace, desktopUi.tokens), join(target, 'tokens.json'));
};

// Clean only what this build owns: other steps write `splash@<v>/` here.
await mkdir(platformOut, { recursive: true });
for (const dir of new Set(groups.map((group) => group.dir.split('/')[0]))) {
  if (dir.startsWith('@')) {
    for (const group of groups.filter((g) => g.dir.startsWith(`${dir}/`))) {
      await rm(join(platformOut, group.dir), { recursive: true, force: true });
    }
  } else {
    await rm(join(platformOut, dir), { recursive: true, force: true });
  }
}
await rm(join(platformOut, 'importmap.platform.json'), { force: true });

const imports = {};
for (const group of groups) {
  const emitted = await buildGroup(group);
  for (const entry of group.entries) {
    if (!emitted.has(entry.file)) {
      throw new Error(`${group.dir}: ${entry.file} was not emitted.`);
    }
    imports[entry.specifier] =
      `${platformUrl}${posix.join(group.dir, entry.file)}`;
  }
  if (group.kind === 'desktop-ui') {
    imports['desktop-ui/'] = `${platformUrl}${group.dir}/`;
  }
}
await buildTheme();

const sorted = Object.fromEntries(
  Object.entries(imports).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
await writeFile(
  join(platformOut, 'importmap.platform.json'),
  `${JSON.stringify({ imports: sorted }, null, 2)}\n`,
);

await rm(join(out, 'schemas'), { recursive: true, force: true });
await cp(join(workspace, schemas), join(out, 'schemas'), { recursive: true });

console.log(
  `doric-platform: ${Object.keys(sorted).length} import-map entries (${mode}) in ${relative(workspace, platformOut)}`,
);
