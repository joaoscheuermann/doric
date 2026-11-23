// The files a host part reads at run time, and the packages with native code
// it loads (spec `docs/designs/grpc-processes.md`, section 14, "Assets"
// (D35) and "Native code"). Development only (phases 3 to 6): the SDK reads
// the bundle directory on disk. Phase 7 adds the single executable
// application (`node:sea`), with the same refusals.

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';

import {
  hostAssetsOf,
  isNormalForm,
  parseManifest,
} from '../../runtime/manifest.js';

/**
 * A host part's assets, as `context.assets` answers them: the files the
 * manifest's `host.assets` globs match, each named by its path relative to
 * the bundle directory (`src/host/skills/openui.md`).
 *
 * The bundle directory is the directory `startBundle` was given
 * (`StartBundleOptions.bundleDir`); `runBundle` gives two directories above
 * `process.argv[1]`, which is `<bundle dir>/dist/host/main.mjs`. The globs are
 * `host.assets` of `<bundle dir>/manifest.json`, read and validated by the
 * first call that needs them and kept for the life of the process (a later
 * edit of the manifest is not seen). `host.assets` absent means no asset.
 *
 * Every error message names the bundle as `context.instance.bundleId`.
 */
export interface HostAssets {
  /**
   * The bytes of the asset at `path`.
   *
   * `path` is relative to the bundle directory, with `/` separators, in
   * normal form: not absolute, no `.` or `..` segment, no empty segment, no
   * `\`. Resolves with the whole file's content; the caller must treat it as
   * a `Uint8Array`, not rely on it being a `Buffer`.
   *
   * Rejects, reading nothing, with an `Error` whose message names `path` and
   * the bundle and says it is not listed in `host.assets` when `path` is not
   * in normal form or no glob of `host.assets` matches it (`path.posix.matchesGlob`
   * semantics). This holds in development too, so a read that would fail in
   * the executable fails before it (coordinator decision, version 6.12).
   *
   * Rejects with an `Error` whose message names `path` and the bundle and
   * says it is missing, with `cause` the read error, when a glob matches
   * `path` but no readable file is there.
   *
   * Rejects with an `Error` naming the bundle, with `cause` the underlying
   * error, when the bundle directory is unknown or its `manifest.json` is
   * missing or is not a valid manifest; every later call rejects the same
   * way.
   */
  read(path: string): Promise<Uint8Array>;
  /**
   * The absolute directory under which each asset is a file at
   * `<directory>/<path>`, for code that needs files on disk (a binary to
   * run, a directory to resolve from). `prefix`, a path in the normal form of
   * {@link read} or absent for all assets, names the assets the caller needs:
   * those whose path starts with it.
   *
   * In development it resolves with the bundle directory, whatever `prefix`
   * is, and writes nothing. (Phase 7: in an executable it writes the assets
   * under `prefix` below `DORIC_BUNDLE_CACHE` once per version, with their
   * SHA-256 checked, and answers that directory.)
   *
   * Rejects with an `Error` naming the bundle when the bundle directory is
   * unknown. Resolves with the same directory on every call.
   */
  extract(prefix?: string): Promise<string>;
  /**
   * Loads the package or module `specifier` with CommonJS `require`, for a
   * package with native code that `dist/host/main.mjs` must not bundle
   * (`esbuild`, `tailwindcss`, `@tailwindcss/oxide`). Answers what `require`
   * answers (the module's `exports`), loaded once per process as Node caches
   * it.
   *
   * In development it is `createRequire(<bundle dir>/package.json)(specifier)`:
   * Node resolves `specifier` from the bundle directory's `node_modules`, then
   * each parent directory's, the repository root's included. `host.assets`
   * is not consulted. (Phase 7: in an executable it loads from the directory
   * `extract` answers.)
   *
   * Throws what `require` throws (`code` `MODULE_NOT_FOUND` for a package it
   * cannot resolve; a module's own load error unchanged). Throws an `Error`
   * naming the bundle when the bundle directory is unknown.
   */
  require(specifier: string): unknown;
}

/**
 * The `context.assets` of a bundle whose directory is `bundleDir` (absolute,
 * or `undefined` when unknown) and whose instance is `bundleId`. Creating it
 * reads nothing and never throws; each method fails as {@link HostAssets}
 * says. Used by `startBundle` and by `bundle/testing`'s `createTestRouter`.
 */
export const createHostAssets = (options: {
  readonly bundleDir: string | undefined;
  readonly bundleId: string;
}): HostAssets => {
  const { bundleDir, bundleId } = options;
  const unknownDir = (): Error =>
    new Error(`The bundle directory of bundle ${bundleId} is unknown.`);
  let globs: Promise<readonly string[]> | undefined;

  const readGlobs = async (dir: string): Promise<readonly string[]> => {
    try {
      const text = await readFile(join(dir, 'manifest.json'), 'utf8');

      return hostAssetsOf(parseManifest(JSON.parse(text)).manifest);
    } catch (error) {
      throw new Error(
        `The manifest.json of bundle ${bundleId} could not be read.`,
        { cause: error },
      );
    }
  };

  return {
    read: async (path) => {
      if (bundleDir === undefined) {
        throw unknownDir();
      }

      globs ??= readGlobs(bundleDir);

      const listed = await globs;

      if (
        !isNormalForm(path) ||
        !listed.some((glob) => posix.matchesGlob(path, glob))
      ) {
        throw new Error(
          `The asset ${path} of bundle ${bundleId} is not listed in host.assets.`,
        );
      }

      try {
        return await readFile(join(bundleDir, ...path.split('/')));
      } catch (error) {
        throw new Error(
          `The asset ${path} of bundle ${bundleId} is missing.`,
          { cause: error },
        );
      }
    },
    extract: () =>
      bundleDir === undefined
        ? Promise.reject(unknownDir())
        : Promise.resolve(bundleDir),
    require: (specifier) => {
      if (bundleDir === undefined) {
        throw unknownDir();
      }

      return createRequire(join(bundleDir, 'package.json'))(specifier);
    },
  };
};
