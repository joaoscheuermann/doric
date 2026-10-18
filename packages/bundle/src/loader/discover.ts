import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { QuarantineReason } from '../contracts/platform.js';
import { type Descriptor, emptyDescriptor } from '../runtime/descriptor.js';
import type { ReadManifest } from '../runtime/manifest.js';
import { readDescriptor, readManifest } from './read.js';

export interface InstalledBundle {
  /** Absolute bundle directory. */
  readonly dir: string;
  readonly read?: ReadManifest;
  readonly descriptor?: Descriptor;
  readonly errors: readonly QuarantineReason[];
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const describe = (error: unknown): string => {
  const parts: string[] = [];

  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    parts.push(current.message);
  }

  return parts.length > 0 ? parts.join(': ') : String(error);
};

/** Reads one installed bundle directory without executing any of its code. */
export const readInstalledBundle = async (
  dir: string,
): Promise<InstalledBundle> => {
  let read: ReadManifest;

  try {
    read = await readManifest(dir);
  } catch (error) {
    return {
      dir,
      errors: [{ code: 'invalid_manifest', message: describe(error) }],
    };
  }

  if (read.legacy !== undefined) {
    // A v0 bundle has no contracts.json: it provides nothing.
    return {
      dir,
      read,
      descriptor: emptyDescriptor(read.manifest.id, read.manifest.version),
      errors: [],
    };
  }

  try {
    const descriptor = await readDescriptor(dir);

    return descriptor === undefined
      ? { dir, read, errors: [] }
      : { dir, read, descriptor, errors: [] };
  } catch (error) {
    return {
      dir,
      read,
      errors: [{ code: 'invalid_descriptor', message: describe(error) }],
    };
  }
};

/** Immediate subdirectories of `root`, sorted by full path, each read. */
export const discoverBundles = async (
  root: string,
): Promise<readonly InstalledBundle[]> => {
  let entries: Dirent[];

  try {
    entries = await readdir(resolve(root), { withFileTypes: true });
  } catch (cause) {
    throw new Error(`Unable to discover bundles in root "${root}".`, { cause });
  }

  const paths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(resolve(root), entry.name))
    .sort(compare);
  const bundles: InstalledBundle[] = [];

  for (const path of paths) {
    bundles.push(await readInstalledBundle(path));
  }

  return bundles;
};
