// Builds the desktop parts of a bundle: `src/desktop/index.ts` (desktopMain,
// run in a utilityProcess) and `src/client/index.ts` (+ `styles.css`, run in
// a window). Both are ESM with the platform specifiers left external, so one
// instance of `zod`, `bundle/contracts`, each `<id>/contracts` and, in a
// window, each generated module and `@bufbuild/protobuf` exists per
// generation (A53). A client's frames (`src/client/frames/*.ts`) are modules
// of their own, for documents outside the window: only the frame import
// map's specifiers stay external.

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

import { parseManifest } from '../runtime/manifest.js';
import {
  clientExternals,
  frameExternals,
  matchesExternal,
} from './externals.js';

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
  /** The client's frames, `client/frames/<name>.js`. */
  readonly frames?: readonly string[];
  /**
   * The client's chunks, `client/chunks/<name>.js`, one per
   * `src/client/chunks/<name>.ts`, in file-name order; present only when the
   * bundle has a client entry and at least one chunk. Each chunk's CSS, when
   * it has any, is `client/chunks/<name>.css` beside it, never part of
   * `clientStyles`. The window's loader never loads a chunk itself: the
   * client entry imports it.
   */
  readonly chunks?: readonly string[];
}

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
    name === '@base-ui/react' ||
    name === 'lexical' ||
    name.startsWith('@lexical/') ||
    name === 'desktop'
  );
};

/** Imports a client part must not contain. */
const forbiddenInClient = (specifier: string): boolean =>
  specifier === 'bundle' ||
  specifier === 'bundle/runtime' ||
  specifier === 'desktop' ||
  specifier === 'desktop/client' ||
  specifier.startsWith('desktop/client/');

/**
 * Imports a frame must not contain: the window's own modules, and the
 * window's import-map specifiers the frame's map does not have (a second
 * React, `desktop/ui`, contracts), except `zod`, which a frame bundles.
 */
const forbiddenInFrame = (specifier: string): boolean =>
  forbiddenInClient(specifier) ||
  specifier.startsWith('bundle/') ||
  specifier.startsWith('desktop/') ||
  (matchesExternal(clientExternals, specifier) &&
    !matchesExternal(frameExternals, specifier) &&
    specifier !== 'zod' &&
    !specifier.startsWith('zod/'));

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
 * outside `gen/` become the external `<id>/contracts`; in a window module,
 * `<package>/contracts/gen/<path>` and a relative import into the bundle's
 * own `src/contracts/gen/` stay external (A53); forbidden imports fail.
 */
const EXTERNAL_REQUIRE = 'doric-external-require';

/** `<package>/contracts/gen/<path>`: one package segment, a non-empty path. */
const GENERATED_SPECIFIER = /^[^./@][^/]*\/contracts\/gen\/.+$/;

const partPlugin = (input: {
  readonly id: string;
  readonly contractsDir: string;
  readonly part: 'desktop' | 'client' | 'frame';
  readonly forbidden: (specifier: string) => boolean;
  /** The part's external specifiers (stage 9). */
  readonly external?: readonly string[];
  /**
   * True for the window modules (the client entry and its chunks): generated
   * code stays external as `<package>/contracts/gen/<path>`. Absent for the
   * desktop part, workers and frames, which bundle what they import.
   */
  readonly windowModule?: boolean;
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

      if (input.windowModule && GENERATED_SPECIFIER.test(args.path)) {
        return { path: args.path, external: true };
      }

      // A frame bundles the contracts' sources it imports: its document
      // has no `<id>/contracts`.
      if (args.path.startsWith('.') && input.part !== 'frame') {
        const target = resolve(args.resolveDir, args.path);
        const generatedDir = join(input.contractsDir, 'gen');

        if (inside(generatedDir, target)) {
          const path = relative(generatedDir, target).split(sep).join('/');

          if (input.windowModule && path !== '') {
            return {
              path: `${input.id}/contracts/gen/${path}`,
              external: true,
            };
          }

          return undefined;
        }

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
            // D23: libraries' development branches (dev tools among them)
            // neither run nor ship in a window, in either build mode: the
            // define folds their guards to `false`, and syntax minification
            // drops the dead branches (identifiers and whitespace stay).
            define: { 'process.env.NODE_ENV': '"production"' },
            minifySyntax: true,
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

/**
 * The `.ts` files directly in a folder (`src/client/workers/*.ts`,
 * `src/client/frames/*.ts`), each an entry; subfolders hold their modules.
 */
const entriesOf = async (dir: string): Promise<readonly string[]> => {
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
 *
 * Window modules (the client entry `client/index.js` and its chunks
 * `client/chunks/*.js`) keep external:
 * - every `clientExternals` specifier, `@bufbuild/protobuf` and its subpaths
 *   included;
 * - every specifier `<package>/contracts/gen/<path>` (one package segment,
 *   a non-empty path), as written;
 * - a relative import that resolves inside the bundle's own
 *   `src/contracts/gen/`, as the specifier `<id>/contracts/gen/<path>`,
 *   `<path>` being the target relative to that directory with `/`
 *   separators and the extension as written (`_pb.js`);
 * - a relative import that resolves elsewhere inside `src/contracts/`, as
 *   `<id>/contracts` (unchanged).
 * So a window module's output holds no generated file and no
 * `@bufbuild/protobuf` code.
 *
 * The desktop part and client workers bundle generated code: a relative
 * import inside `src/contracts/gen/` is no longer turned into
 * `<id>/contracts` for any part. Frames are unchanged, except that
 * `@bufbuild/protobuf`, now a window specifier, is a forbidden import of a
 * frame like the other window specifiers but `zod`.
 *
 * Fails with `PartBuildError` as today (a forbidden import, an esbuild
 * error); this change adds no error. Returns the built parts as
 * dist-relative paths, as today.
 */
export const buildParts = async (
  options: PartBuildOptions,
): Promise<BuiltParts> => {
  const root = resolve(options.bundleDir);
  const dist = join(root, 'dist');
  const { manifest } = parseManifest(
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
    frames?: readonly string[];
    chunks?: readonly string[];
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
        windowModule: true,
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

    for (const name of await entriesOf(workersDir)) {
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

  // Chunks are window modules the client imports on demand: the client's
  // externals, and the CSS esbuild extracts kept beside each as
  // `client/chunks/<name>.css`, not merged into `client/styles.css`. Without
  // a client entry nothing imports them, so none is built.
  await rm(join(dist, 'client', 'chunks'), { recursive: true, force: true });

  if (hasClient) {
    const chunksDir = join(root, 'src', 'client', 'chunks');
    const chunks = await entriesOf(chunksDir);

    for (const name of chunks) {
      await buildScript({
        entry: join(chunksDir, name),
        outfile: join(dist, 'client', 'chunks', name.replace(/\.ts$/, '.js')),
        platform: 'browser',
        external: clientExternals,
        plugin: partPlugin({
          id: manifest.id,
          contractsDir,
          part: 'client',
          forbidden: forbiddenInClient,
          external: clientExternals,
          windowModule: true,
        }),
        mode: options.mode,
        label: `client chunk ${name}`,
      });
    }

    if (chunks.length > 0) {
      built.chunks = chunks.map(
        (name) => `client/chunks/${name.replace(/\.ts$/, '.js')}`,
      );
    }
  }

  // Frames run in documents of their own (a preview's sandboxed iframe),
  // with the frame import map: `client/frames/<name>.js`, never loaded by
  // the build's dry activation.
  const framesDir = join(root, 'src', 'client', 'frames');
  const frames = await entriesOf(framesDir);

  await rm(join(dist, 'client', 'frames'), { recursive: true, force: true });

  for (const name of frames) {
    await buildScript({
      entry: join(framesDir, name),
      outfile: join(dist, 'client', 'frames', name.replace(/\.ts$/, '.js')),
      platform: 'browser',
      external: frameExternals,
      plugin: partPlugin({
        id: manifest.id,
        contractsDir,
        part: 'frame',
        forbidden: forbiddenInFrame,
        external: frameExternals,
      }),
      mode: options.mode,
      label: `client frame ${name}`,
    });
  }

  if (frames.length > 0) {
    built.frames = frames.map(
      (name) => `client/frames/${name.replace(/\.ts$/, '.js')}`,
    );
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
