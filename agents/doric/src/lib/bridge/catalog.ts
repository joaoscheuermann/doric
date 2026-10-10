// The host's distribution members of `doric.catalog/v1` (HR-2..HR-4, HR-8):
// what the desktop reads of a host generation to download, verify and
// resolve its desktopMain and client parts.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type CatalogDistributionProvider,
  catalogSnapshot,
  distributionFor,
  type KernelDistributionSource,
  type ResolvedEnvironment,
} from 'bundle';
import {
  type CatalogChange,
  ContractError,
  type DistributionCatalog,
  generationOf,
  type StreamListener,
} from 'bundle/contracts';
import { PLATFORM_VERSION, toDisposable } from 'bundle/runtime';

export interface CatalogDistributionOptions {
  readonly source: KernelDistributionSource;
  /** Random per host process [S8-22]. */
  readonly hostBoot: string;
  readonly platformVersion?: string;
}

/** One generation's files, computed once: a published generation's files do not change. */
interface Published {
  readonly catalog: DistributionCatalog;
  /** sha256 → the installed file that holds it. */
  readonly files: ReadonlyMap<string, string>;
}

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const createCatalogDistribution = ({
  source,
  hostBoot,
  platformVersion = PLATFORM_VERSION,
}: CatalogDistributionOptions): CatalogDistributionProvider => {
  const published = new WeakMap<ResolvedEnvironment, Promise<Published>>();

  const publishedOf = (generation: number) => {
    const view = source.generation(generation);
    let entry = published.get(view.resolved);

    if (entry === undefined) {
      entry = (async () => {
        const catalog = await distributionFor({
          resolved: view.resolved,
          states: view.states,
          hostBoot,
          platformVersion,
        });
        const files = new Map<string, string>();

        for (const [index, bundle] of catalog.bundles.entries()) {
          const installed = view.resolved.entries[index]?.source;

          if (installed?.kind !== 'installed') {
            continue;
          }

          for (const file of bundle.files) {
            if (!files.has(file.sha256)) {
              files.set(
                file.sha256,
                join(installed.dir, ...file.path.split('/')),
              );
            }
          }
        }

        return { catalog, files };
      })();
      entry.catch(() => published.delete(view.resolved));
      published.set(view.resolved, entry);
    }

    return { view, entry };
  };

  return {
    distribution: async (call) => {
      const { view, entry } = publishedOf(generationOf(call));
      const { catalog } = await entry;
      // Bundle states and the storage identity are live; the files are not.
      const storage = source.storage();
      const host = catalogSnapshot(view.resolved, view.states, storage);

      return {
        ...catalog,
        composition: host.composition,
        ...(storage === undefined ? {} : { storage }),
        host,
        bundles: catalog.bundles.map((bundle, index) => {
          const live = host.bundles[index];

          return live === undefined
            ? bundle
            : { ...bundle, state: live.state, reasons: [...live.reasons] };
        }),
      };
    },
    artifact: async ({ sha256 }) => {
      // Only a file listed by a retained generation is served (HR-3).
      for (const generation of new Set([0, ...source.retained()])) {
        const path = (await publishedOf(generation).entry).files.get(sha256);

        if (path === undefined) {
          continue;
        }

        const bytes = await readFile(path).catch(() => undefined);

        if (bytes !== undefined && sha256Of(bytes) === sha256) {
          return { sha256, base64: bytes.toString('base64') };
        }
      }

      throw new ContractError(
        'not_found',
        `No retained generation distributes an artifact with SHA-256 ${sha256}.`,
        { sha256 },
      );
    },
    watch: (listener: StreamListener<CatalogChange>, call) => {
      const next = typeof listener === 'function' ? listener : listener.next;
      let last = source.generation(generationOf(call)).generation;
      const stop = source.onActive((generation) => {
        // A respawn re-activates the same generation: nothing was published.
        if (generation === last) {
          return;
        }

        last = generation;
        next.call(listener, { generation });
      });

      return toDisposable(stop);
    },
  };
};
