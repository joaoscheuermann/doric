// Builds the desktop parts of a bundle: `src/desktop/index.ts` (desktopMain,
// run in a utilityProcess) and `src/client/index.ts` (+ `styles.css`, run in
// a window). Both are ESM with the platform specifiers left external, so one
// instance of `zod`, `bundle/contracts` and each `<id>/contracts` exists per
// generation.

import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { type BuildFailure, build, type Plugin } from 'esbuild';

import { manifestV1Schema } from '../runtime/manifest.js';

export class PartBuildError extends Error {
  override readonly name = 'PartBuildError';
}

export interface PartBuildOptions {
  /** The bundle project directory (with `manifest.json` and `src/`). */
  readonly bundleDir: string;
  readonly mode: 'production' | 'development';
}

/** The parts written below `dist/`, as dist-relative paths. */
export interface BuiltParts {
  readonly desktopMain?: string;
  readonly client?: string;
  readonly clientStyles?: string;
}

/** Import-map specifiers a client part leaves to the window (decision "Import map"). */
const clientExternals = [
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  'lexical',
  '@lexical/*',
  'desktop-ui',
  'desktop-ui/*',
  'zod',
  'zod/*',
  'bundle/contracts',
  '*/contracts',
];

/** What the desktopMain runner resolves (plus Node built-ins). */
const desktopExternals = [
  'bundle/contracts',
  'zod',
  'zod/*',
  '*/contracts',
  'electron',
];

const packageOf = (specifier: string): string => {
  const parts = specifier.split('/');

  return specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : (parts[0] ?? specifier);
};

/** Imports a desktopMain part must not contain. */
const forbiddenInDesktop = (specifier: string): boolean => {
  const name = packageOf(specifier);

  return (
    specifier === 'bundle' ||
    name === 'react' ||
    name === 'react-dom' ||
    name === 'lexical' ||
    name.startsWith('@lexical/') ||
    name === 'desktop-ui' ||
    name === 'desktop-client'
  );
};

/** Imports a client part must not contain. */
const forbiddenInClient = (specifier: string): boolean =>
  specifier === 'bundle' ||
  specifier === 'bundle/runtime' ||
  packageOf(specifier) === 'desktop-client';

const exists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);

  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
};

/**
 * [S8-18] Imports that resolve into the bundle's own `src/contracts/**`
 * become the external `<id>/contracts`, and forbidden imports fail.
 */
/** Whether a specifier is one of esbuild-style `external` patterns. */
const matchesExternal = (
  external: readonly string[],
  specifier: string,
): boolean =>
  external.some((pattern) => {
    const star = pattern.indexOf('*');

    if (star < 0) {
      return pattern === specifier;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    return (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    );
  });

const EXTERNAL_REQUIRE = 'doric-external-require';

const partPlugin = (input: {
  readonly id: string;
  readonly contractsDir: string;
  readonly part: 'desktop' | 'client';
  readonly forbidden: (specifier: string) => boolean;
  /** The part's external specifiers (stage 9). */
  readonly external?: readonly string[];
}): Plugin => ({
  name: 'doric-part',
  setup(context) {
    // Stage 9: a bundled CommonJS dependency that `require`s an external
    // (`use-sync-external-store` requiring `react`) would get esbuild's
    // throwing `__require` in ESM output. The require is served by a module
    // that re-exports the external's ESM namespace, so the external stays
    // one instance from the import map.
    context.onLoad({ filter: /.*/, namespace: EXTERNAL_REQUIRE }, (args) => ({
      contents: `export * from ${JSON.stringify(args.path)};\n`,
      loader: 'js',
    }));

    context.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === 'entry-point') {
        return undefined;
      }

      if (
        args.kind === 'require-call' &&
        args.namespace !== EXTERNAL_REQUIRE &&
        input.external !== undefined &&
        !input.forbidden(args.path) &&
        matchesExternal(input.external, args.path)
      ) {
        return { path: args.path, namespace: EXTERNAL_REQUIRE };
      }

      if (input.forbidden(args.path)) {
        return {
          errors: [
            {
              text: `A ${input.part} part must not import "${args.path}".`,
            },
          ],
        };
      }

      if (args.path.startsWith('.')) {
        const target = resolve(args.resolveDir, args.path);

        if (inside(input.contractsDir, target)) {
          return { path: `${input.id}/contracts`, external: true };
        }
      }

      return undefined;
    });
  },
});

const describeFailure = (error: unknown): string => {
  const failure = error as Partial<BuildFailure>;

  if (Array.isArray(failure.errors) && failure.errors.length > 0) {
    return failure.errors
      .map((entry) =>
        entry.location === null || entry.location === undefined
          ? entry.text
          : `${entry.location.file}:${entry.location.line}: ${entry.text}`,
      )
      .join('\n');
  }

  return error instanceof Error ? error.message : String(error);
};

const buildScript = async (input: {
  readonly entry: string;
  readonly outfile: string;
  readonly platform: 'node' | 'browser';
  readonly external: readonly string[];
  readonly plugin: Plugin;
  readonly mode: PartBuildOptions['mode'];
  readonly label: string;
}): Promise<void> => {
  try {
    await build({
      entryPoints: [input.entry],
      outfile: input.outfile,
      bundle: true,
      format: 'esm',
      platform: input.platform,
      target: input.platform === 'node' ? 'node22' : 'es2022',
      external: [...input.external],
      plugins: [input.plugin],
      // Stage 9: fonts a client imports (directly or through CSS) are files
      // next to the part, served from the bundle's own directory.
      ...(input.platform === 'browser'
        ? {
            loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
            assetNames: 'assets/[name]-[hash]',
          }
        : {}),
      sourcemap: input.mode === 'development' ? 'inline' : false,
      logLevel: 'silent',
      write: true,
    });
  } catch (error) {
    throw new PartBuildError(
      `Building the ${input.label} part failed:\n${describeFailure(error)}`,
    );
  }
};

/** A bundle's client CSS: Tailwind utilities over the platform theme, no `@theme`. */
const buildStyles = async (source: string): Promise<string> => {
  const css = await readFile(source, 'utf8');

  if (/@theme\b/.test(css)) {
    throw new PartBuildError(
      `${source}: a bundle's client CSS must not extend @theme.`,
    );
  }

  const base = dirname(source);
  let output: string;

  try {
    const compiler = await compile(css, {
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
    const scanner = new Scanner({ sources });

    output = compiler.build(scanner.scan());
  } catch (error) {
    throw new PartBuildError(
      `Building ${source} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return output;
};

/** `src/client/workers/*.ts`: each a self-contained module worker. */
const workerEntries = async (dir: string): Promise<readonly string[]> => {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * Builds the desktop parts the bundle has sources for into `dist/desktop/`
 * and `dist/client/`, replacing earlier outputs of those folders.
 */
export const buildParts = async (
  options: PartBuildOptions,
): Promise<BuiltParts> => {
  const root = resolve(options.bundleDir);
  const dist = join(root, 'dist');
  const manifest = manifestV1Schema.parse(
    JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')),
  );
  const contractsDir = join(root, 'src', 'contracts');
  const desktopEntry = join(root, 'src', 'desktop', 'index.ts');
  const clientEntry = join(root, 'src', 'client', 'index.ts');
  const clientStyles = join(root, 'src', 'client', 'styles.css');
  const built: {
    desktopMain?: string;
    client?: string;
    clientStyles?: string;
  } = {};

  // Only a part with a source entry is (re)built; a dist part without one
  // (emitted by another step) is left as it is.
  if (await exists(desktopEntry)) {
    await rm(join(dist, 'desktop'), { recursive: true, force: true });
    await buildScript({
      entry: desktopEntry,
      outfile: join(dist, 'desktop', 'index.js'),
      platform: 'node',
      external: desktopExternals,
      plugin: partPlugin({
        id: manifest.id,
        contractsDir,
        part: 'desktop',
        forbidden: forbiddenInDesktop,
        external: desktopExternals,
      }),
      mode: options.mode,
      label: 'desktop',
    });
    built.desktopMain = 'desktop/index.js';
  }

  const hasClient = await exists(clientEntry);
  const hasStyles = await exists(clientStyles);

  if (hasClient || hasStyles) {
    await rm(join(dist, 'client'), { recursive: true, force: true });
  }

  // CSS esbuild extracted from the client's JS imports (Monaco, xterm).
  const extracted = join(dist, 'client', 'index.css');
  let importedCss: string | undefined;

  if (hasClient) {
    await buildScript({
      entry: clientEntry,
      outfile: join(dist, 'client', 'index.js'),
      platform: 'browser',
      external: clientExternals,
      plugin: partPlugin({
        id: manifest.id,
        contractsDir,
        part: 'client',
        forbidden: forbiddenInClient,
        external: clientExternals,
      }),
      mode: options.mode,
      label: 'client',
    });
    built.client = 'client/index.js';

    if (await exists(extracted)) {
      importedCss = await readFile(extracted, 'utf8');
      await rm(extracted, { force: true });
    }

    // Workers run outside the window's import map: nothing is external.
    const workersDir = join(root, 'src', 'client', 'workers');

    for (const name of await workerEntries(workersDir)) {
      await buildScript({
        entry: join(workersDir, name),
        outfile: join(dist, 'client', 'workers', name.replace(/\.ts$/, '.js')),
        platform: 'browser',
        external: [],
        plugin: partPlugin({
          id: manifest.id,
          contractsDir,
          part: 'client',
          forbidden: forbiddenInClient,
        }),
        mode: options.mode,
        label: `client worker ${name}`,
      });
    }
  }

  if (hasStyles || importedCss !== undefined) {
    const tailwind = hasStyles ? await buildStyles(clientStyles) : '';
    const css =
      importedCss === undefined
        ? tailwind
        : tailwind === ''
          ? importedCss
          : `${tailwind.replace(/\n*$/, '\n')}${importedCss}`;

    await mkdir(join(dist, 'client'), { recursive: true });
    await writeFile(join(dist, 'client', 'styles.css'), css);
    built.clientStyles = 'client/styles.css';
  }

  return built;
};
