// Path B: compiles a `component` preview into a live module and its sheet.
//
// The module is bundled where the Project's files are when it can be: the
// sandbox runs the bundle (`sandbox.ts`) with the esbuild its image installs,
// reading the workspace's own disk. A sandbox that cannot answers why, and
// the host bundles instead, reading each file through `files/v1` under that
// reader's budget (`bundle.ts`). Either way the host finishes the module:
//
// - a `WINDOW_PACKAGES` specifier the sandbox left to the window is checked
//   against the host's own copy; one the window does not serve is bundled
//   after all, by asking the sandbox again with it named;
// - `HOST_PACKAGES` the sandbox left external are bundled in from the host's
//   own `node_modules` in one more pass over the module alone;
// - the sheet (`css.ts`) compiles on the host, over the Project-authored
//   sources the bundle read, with the stylesheets the sandbox already read.
//
// esbuild and the Tailwind compiler are loaded on demand: they are workspace
// tools the host image ships, and an `html` preview never pays for them.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BuildOptions } from 'esbuild';

import {
  type BundledComponent,
  bundleComponent,
  compileFailure,
  HOST_PACKAGES,
  previewExternals,
  type SourceReader,
  sourceCache,
} from './bundle.js';
import {
  compileStyles,
  type ProjectBytesReader,
  type StyleAsset,
} from './css.js';
import { isRelative, packageOf } from './paths.js';
import type { SandboxBundler } from './sandbox.js';

/** The compiled module and sheet of one component preview. */
export interface CompiledComponent {
  /** The ESM module: `export function mount(root, { theme })`. */
  readonly js: string;
  /** The Tailwind sheet the module's classes need, linked in its document. */
  readonly css: string;
  /** The fonts and images the sheet names, stored beside it. */
  readonly assets: readonly StyleAsset[];
  /** The export of the source the module mounts (a story's, for CSF). */
  readonly exportName: string;
  /** The Project harness the module applies, when it has one. */
  readonly harness?: string;
  /** What the build skipped without failing. */
  readonly warnings: readonly string[];
}

/** The directory esbuild resolves `HOST_PACKAGES` from: this module's own. */
const hostResolveDir = (): string => dirname(fileURLToPath(import.meta.url));

/** One plain esbuild build, as the host's copy runs it. */
type HostBuild = (options: BuildOptions) => Promise<unknown>;

const windowServed = new Map<string, Promise<boolean>>();

/**
 * Whether the window's import map serves a specifier of a `WINDOW_PACKAGES`
 * package: whether the host's own copy bundles it, with the React the window
 * serves left out, as the platform's build bundles it from its install (the
 * map lists no `package.json`). Asked once per specifier for the host's life.
 */
const windowServes = (
  build: HostBuild,
  specifier: string,
): Promise<boolean> => {
  let served = windowServed.get(specifier);

  if (served === undefined) {
    served = specifier.endsWith('/package.json')
      ? Promise.resolve(false)
      : build({
          entryPoints: [specifier],
          absWorkingDir: hostResolveDir(),
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'browser',
          external: [...previewExternals],
          logLevel: 'silent',
        }).then(
          () => true,
          () => false,
        );
    windowServed.set(specifier, served);
  }

  return served;
};

/**
 * Bundles the `HOST_PACKAGES` a module left external into it, from the host's
 * own `node_modules`; everything else the module imports stays external.
 */
const bundleHostPackages = async (
  build: typeof import('esbuild').build,
  js: string,
): Promise<string> => {
  const result = await build({
    stdin: {
      contents: js,
      loader: 'js',
      resolveDir: hostResolveDir(),
      sourcefile: 'index.js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    plugins: [
      {
        name: 'papercraft-host-packages',
        setup(context) {
          // The module is bundled already: its only imports are bare ones,
          // so a relative import is a host package's own file.
          context.onResolve({ filter: /.*/ }, (args) =>
            previewExternals.includes(args.path) ||
            (!isRelative(args.path) &&
              !HOST_PACKAGES.includes(packageOf(args.path)))
              ? { path: args.path, external: true }
              : undefined,
          );
        },
      },
    ],
  });

  return result.outputFiles[0]?.text ?? js;
};

/**
 * The sandbox's bundle, once every window specifier it left out is one the
 * window serves; `undefined` when the sandbox cannot bundle.
 */
const sandboxBundle = async (
  bundler: SandboxBundler,
  build: HostBuild,
  input: { readonly path: string; readonly entry?: string },
  version: string,
): Promise<
  | {
      readonly bundled: BundledComponent;
      readonly styles: ReadonlyMap<string, string>;
    }
  | undefined
> => {
  let windowUnserved: readonly string[] = [];

  for (;;) {
    const outcome = await bundler({ ...input, version, windowUnserved });

    if (outcome.status === 'failed') throw outcome.error;
    if (outcome.status === 'unavailable') return undefined;

    const unserved: string[] = [];

    for (const specifier of outcome.bundled.windowSpecifiers) {
      if (!(await windowServes(build, specifier))) unserved.push(specifier);
    }

    // Asked once more at most: that answer bundles every unserved specifier.
    if (unserved.length === 0 || windowUnserved.length > 0) return outcome;

    windowUnserved = unserved;
  }
};

/**
 * Compiles one component source into the preview module and its sheet: in
 * the sandbox through `bundler` when it can, else on the host through `read`.
 * Fails with `invalid_input`, naming esbuild's errors, when the source does
 * not compile, an import cannot be resolved, or the export to mount is
 * missing. A Project harness that does not compile is left out with a warning.
 */
export const compileComponent = async (
  read: SourceReader,
  input: { readonly path: string; readonly entry?: string },
  bundler?: SandboxBundler,
  readBytes?: ProjectBytesReader,
): Promise<CompiledComponent> => {
  const { build, version } = await import('esbuild');
  const cached = sourceCache(read);
  const sandboxed =
    bundler === undefined
      ? undefined
      : await sandboxBundle(bundler, build, input, version);
  const bundled =
    sandboxed?.bundled ??
    (await bundleComponent({
      read: cached,
      build,
      ...input,
      windowServes: (specifier) => windowServes(build, specifier),
      hostResolveDir: hostResolveDir(),
    }));
  const styles = sandboxed?.styles;
  const js =
    bundled.hostSpecifiers.length === 0
      ? bundled.js
      : await bundleHostPackages(build, bundled.js).catch((error: unknown) => {
          throw compileFailure(input.path, error);
        });

  const sheet = await compileStyles({
    read: (path) => {
      const known = styles?.get(path);

      return known === undefined ? cached(path) : Promise.resolve(known);
    },
    ...(readBytes === undefined ? {} : { readBytes }),
    sources: bundled.sources,
    globalCss: bundled.globalCss,
    componentCss: bundled.componentCss,
  }).catch((error: unknown) => {
    throw compileFailure(input.path, error);
  });

  return {
    js,
    css: sheet.css,
    assets: sheet.assets,
    exportName: bundled.exportName,
    ...(bundled.harness === undefined ? {} : { harness: bundled.harness }),
    warnings: [...bundled.warnings, ...sheet.warnings],
  };
};
