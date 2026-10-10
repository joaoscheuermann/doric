import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';

import type { StorageIdentity } from '../contracts/basic/storage.js';
import type {
  DistributionBundle,
  DistributionCatalog,
  DistributionFile,
  DistributionParts,
} from '../contracts/platform.js';
import type { JsonObject } from '../contracts/types.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import {
  type BundleStates,
  catalogSnapshot,
} from '../runtime/platform-providers.js';

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Whether a dist-relative path is something the desktop may need. */
const distributed = (path: string): boolean =>
  path === 'manifest.json' ||
  path === 'contracts.json' ||
  path.startsWith('desktop/') ||
  path.startsWith('client/') ||
  path.startsWith('schemas/') ||
  (path.startsWith('contracts/') && path.endsWith('.js'));

const walk = async (root: string, dir: string, out: string[]) => {
  let entries: Dirent[];

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(root, path, out);
    } else if (entry.isFile()) {
      out.push(relative(root, path).split(sep).join('/'));
    }
  }
};

const relativeSpecifiers = (source: string): string[] =>
  [
    ...source.matchAll(
      /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    ),
    ...source.matchAll(/(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
  ].map((match) => match[1] as string);

/**
 * The modules outside `contracts/` that the distributed contracts import
 * relatively (a contracts entry may re-export a helper of another part, as
 * the core's re-exports its model catalog fill): without them the desktop
 * cannot load `<id>/contracts`.
 */
const contractsClosure = async (
  bundleDir: string,
  paths: readonly string[],
): Promise<string[]> => {
  const present = new Set(paths);
  const queue = paths.filter(
    (path) => path.startsWith('contracts/') && path.endsWith('.js'),
  );
  const seen = new Set(queue);
  const extra: string[] = [];

  while (queue.length > 0) {
    const path = queue.pop() as string;
    let source: string;

    try {
      source = await readFile(join(bundleDir, ...path.split('/')), 'utf8');
    } catch {
      continue;
    }

    for (const specifier of relativeSpecifiers(source)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));

      if (target.startsWith('..') || seen.has(target) || !present.has(target)) {
        continue;
      }

      seen.add(target);
      queue.push(target);

      if (!distributed(target)) {
        extra.push(target);
      }
    }
  }

  return extra;
};

/**
 * SHA-256 and size of every file of a staged bundle directory the desktop
 * may need (desktop/**, client/**, contracts/**.js and the modules they
 * import, schemas/**, manifest.json, contracts.json), sorted by path.
 */
export const distributionFiles = async (
  bundleDir: string,
): Promise<DistributionFile[]> => {
  const paths: string[] = [];

  await walk(bundleDir, bundleDir, paths);

  const files: DistributionFile[] = [];
  const listed = [
    ...paths.filter(distributed),
    ...(await contractsClosure(bundleDir, paths)),
  ];

  for (const path of listed.sort(compare)) {
    const bytes = await readFile(join(bundleDir, ...path.split('/')));

    files.push({
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    });
  }

  return files;
};

/** The built parts among a bundle's distributed files. */
export const distributionParts = (
  files: readonly DistributionFile[],
): DistributionParts => {
  const has = (path: string) => files.some((file) => file.path === path);

  return {
    ...(has('desktop/index.js') ? { desktopMain: 'desktop/index.js' } : {}),
    ...(has('client/index.js') ? { client: 'client/index.js' } : {}),
    ...(has('client/styles.css') ? { clientStyles: 'client/styles.css' } : {}),
    ...(has('contracts/index.js') ? { contracts: 'contracts/index.js' } : {}),
  };
};

export interface DistributionInput {
  /** The host environment of the generation. */
  readonly resolved: ResolvedEnvironment;
  /** Live host states of that generation. */
  readonly states: BundleStates;
  /** Random per host process [S8-22]. */
  readonly hostBoot: string;
  readonly platformVersion: string;
  readonly storage?: StorageIdentity;
}

/**
 * The distribution catalog of one host generation. Hashes are read from the
 * installed bundle directories; the host computes it once per generation
 * (the files of a published generation do not change).
 */
export const distributionFor = async (
  input: DistributionInput,
): Promise<DistributionCatalog> => {
  const host = catalogSnapshot(input.resolved, input.states, input.storage);
  const bundles: DistributionBundle[] = [];

  for (const [index, entry] of input.resolved.entries.entries()) {
    const published = host.bundles[index];
    const files =
      entry.source.kind === 'installed'
        ? await distributionFiles(entry.source.dir)
        : [];

    bundles.push({
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
      files,
      parts: distributionParts(files),
    });
  }

  return {
    generation: input.resolved.generation,
    hostBoot: input.hostBoot,
    platformVersion: input.platformVersion,
    composition: host.composition,
    ...(input.storage === undefined ? {} : { storage: { ...input.storage } }),
    host,
    bundles,
  };
};
