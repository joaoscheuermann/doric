// What the desktop reads of the host's resolutions (HR-2..HR-4): the
// distribution `doric.catalog/v1.Distribution` answers and the files
// `ReadArtifact` serves. The platform's port of the kernel's
// `doric-host/src/lib/bridge/catalog.ts`, over resolutions instead of kernel
// generations.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StorageIdentity } from '../contracts/basic/storage.js';
import { ContractError } from '../contracts/error.js';
import type {
  DistributionCatalog,
  DistributionFile,
} from '../contracts/platform.js';
import type { JsonObject } from '../contracts/types.js';
import {
  distributionFiles,
  distributionParts,
} from '../loader/distribution.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import {
  type BundleStates,
  catalogSnapshot,
} from '../runtime/platform-providers.js';
import { PLATFORM_VERSION } from '../runtime/version.js';
import { statesById } from './router/platform-services.js';

export interface PlatformDistributionOptions {
  /** Random per platform: `DistributionResponse.hostBoot` [S8-22]. */
  readonly hostBoot: string;
  /** `PLATFORM_VERSION` when undefined. */
  readonly platformVersion?: string;
  /** Live bundle states (`PlatformOptions.diagnostics`). Read at every call. */
  readonly states: BundleStates;
  /** The storage identity once read; see `CatalogServiceOptions.storage`. */
  readonly storage: () => StorageIdentity | undefined;
}

/** What the desktop reads of the host's resolutions (HR-2..HR-4). */
export interface PlatformDistribution {
  /**
   * The distribution of `resolved`: `distributionFor` with `hostBoot`, the
   * platform version, the live states and storage. The files of one
   * resolution are hashed once (a resolution's bundle directories do not
   * change); `host`, each bundle's `state` and `reasons`, `composition` and
   * `storage` are read at every call. Rejects only when a listed bundle
   * directory cannot be read, with that error; a later call tries again.
   */
  of(resolved: ResolvedEnvironment): Promise<DistributionCatalog>;
  /**
   * Records `resolved` as adopted (the boot's and each publish's): from now
   * on `read` serves the files it lists. Idempotent per resolution.
   */
  adopt(resolved: ResolvedEnvironment): void;
  /**
   * The bytes of the file whose SHA-256 is `sha256`, when a resolution
   * passed to `adopt` lists it and the file on disk still hashes to it.
   * Rejects with `ContractError('not_found')` (details `{ sha256 }`)
   * otherwise. Never answers bytes whose hash differs.
   */
  read(sha256: string): Promise<Uint8Array>;
}

export const createPlatformDistribution = (
  options: PlatformDistributionOptions,
): PlatformDistribution => {
  const platformVersion = options.platformVersion ?? PLATFORM_VERSION;
  /** The files of each resolution's entries, by position, hashed once. */
  const hashed = new Map<
    ResolvedEnvironment,
    Promise<readonly (readonly DistributionFile[])[]>
  >();
  const adopted: ResolvedEnvironment[] = [];

  const filesOf = (
    resolved: ResolvedEnvironment,
  ): Promise<readonly (readonly DistributionFile[])[]> => {
    let files = hashed.get(resolved);

    if (files === undefined) {
      files = Promise.all(
        resolved.entries.map((entry) =>
          entry.source.kind === 'installed'
            ? distributionFiles(entry.source.dir)
            : Promise.resolve([]),
        ),
      );
      hashed.set(resolved, files);
      // A failed read is tried again by the next call.
      files.catch(() => {
        if (hashed.get(resolved) === files) {
          hashed.delete(resolved);
        }
      });
    }

    return files;
  };

  return {
    of: async (resolved) => {
      const files = await filesOf(resolved);
      const storage = options.storage();
      const host = catalogSnapshot(
        resolved,
        statesById(resolved, options.states),
        storage,
      );

      return {
        generation: resolved.generation,
        hostBoot: options.hostBoot,
        platformVersion,
        composition: host.composition,
        ...(storage === undefined ? {} : { storage: { ...storage } }),
        host,
        bundles: resolved.entries.map((entry, index) => {
          const published = host.bundles[index];
          const listed = files[index] ?? [];

          return {
            id: entry.id,
            version: entry.version,
            state: published?.state ?? 'inactive',
            reasons: [...(published?.reasons ?? entry.reasons)],
            ...(published?.manifest === undefined
              ? {}
              : { manifest: published.manifest }),
            ...(entry.descriptor === undefined
              ? {}
              : {
                  descriptor: JSON.parse(
                    JSON.stringify(entry.descriptor),
                  ) as JsonObject,
                }),
            files: listed.map((file) => ({ ...file })),
            parts: distributionParts(listed),
          };
        }),
      };
    },
    adopt: (resolved) => {
      if (!adopted.includes(resolved)) {
        adopted.push(resolved);
        // Hash now, so a read soon after finds the files.
        filesOf(resolved).catch(() => undefined);
      }
    },
    read: async (sha256) => {
      for (const resolved of adopted) {
        let files: readonly (readonly DistributionFile[])[];

        try {
          files = await filesOf(resolved);
        } catch {
          continue;
        }

        for (const [index, entry] of resolved.entries.entries()) {
          if (entry.source.kind !== 'installed') {
            continue;
          }

          for (const file of files[index] ?? []) {
            if (file.sha256 !== sha256) {
              continue;
            }

            let bytes: Buffer;

            try {
              bytes = await readFile(
                join(entry.source.dir, ...file.path.split('/')),
              );
            } catch {
              continue;
            }

            if (createHash('sha256').update(bytes).digest('hex') === sha256) {
              return new Uint8Array(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
              );
            }
          }
        }
      }

      throw new ContractError(
        'not_found',
        `No distributed file has the SHA-256 ${sha256}.`,
        { sha256 },
      );
    },
  };
};
