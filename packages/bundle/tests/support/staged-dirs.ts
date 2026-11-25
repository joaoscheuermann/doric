// Staged bundle directories on disk for the tests of what the platform
// distributes to the desktop (`doric.catalog/v1`'s `Distribution` and
// `ReadArtifact`), and the composition options of its recovery actions
// (`PlatformOptions.composition`) over `resolveHost`. Everything a setup
// writes is removed in `after`.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

import { readCompositionOverrides } from '../../src/loader/overrides.js';
import type { PlatformCompositionOptions } from '../../src/platform/index.js';
import { type FixtureBundle, resolveHost } from './scripted-host.js';

/** The bound on `doric.catalog/v1` stream items: 1 MiB. */
export const maxChunkBytes = 1_048_576;

/** 2.5 MiB of bytes that are not all equal, so a misplaced chunk shows. */
export const bigBytes = (): Buffer => {
  const bytes = Buffer.alloc(2.5 * maxChunkBytes);

  for (let at = 0; at < bytes.length; at += 1) {
    bytes[at] = at % 251;
  }

  return bytes;
};

/** The lowercase hex SHA-256 of `bytes`. */
export const sha256Of = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * The files every staged bundle directory holds, by path: a manifest, a
 * desktop part, a client part, a 2.5 MiB client file and an empty one.
 */
export const stagedFiles = (id: string): Record<string, Buffer> => ({
  'manifest.json': Buffer.from(`${JSON.stringify({ id })}\n`),
  'desktop/index.js': Buffer.from(`export const desktop = '${id}';\n`),
  'client/index.js': Buffer.from(`export const client = '${id}';\n`),
  'client/big.bin': bigBytes(),
  'client/empty.txt': Buffer.alloc(0),
});

export interface StagedDirs {
  /** The temporary directory holding every bundle's directory. */
  readonly root: string;
  /** The directory of a bundle, `<root>/<id>`; `resolveHost`'s `dirOf`. */
  readonly dirOf: (id: string) => string;
  /** Writes the {@link stagedFiles} of each of `ids` into its directory. */
  stage(...ids: readonly string[]): void;
}

/** A temporary root of staged bundle directories, removed in `after`. */
export const stagedDirs = (t: TestContext): StagedDirs => {
  const root = mkdtempSync(join(tmpdir(), 'doric-staged-'));
  const dirOf = (id: string): string => join(root, id);

  t.after(() => rmSync(root, { recursive: true, force: true }));

  return {
    root,
    dirOf,
    stage: (...ids) => {
      for (const id of ids) {
        for (const [path, bytes] of Object.entries(stagedFiles(id))) {
          const file = join(dirOf(id), ...path.split('/'));

          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, bytes);
        }
      }
    },
  };
};

/**
 * The composition options of a host of `core` and `bundles`: the overrides
 * file `<root>/composition.overrides.json`; the composition as written is
 * the one `resolveHost(bundles)` resolves; the next resolution is
 * `resolveHost` with the overrides' `disabled` and `dirOf`, as `generation`.
 */
export const compositionOptions = (
  root: string,
  bundles: Readonly<Record<string, FixtureBundle>>,
  dirOf: (id: string) => string,
): PlatformCompositionOptions => {
  const overridesPath = join(root, 'composition.overrides.json');

  return {
    overridesPath,
    read: async () => resolveHost(bundles, { dirOf }).composition,
    resolve: async (generation) => ({
      ...resolveHost(bundles, {
        dirOf,
        disabled:
          (await readCompositionOverrides(overridesPath))?.disabled ?? [],
      }),
      generation,
    }),
  };
};
