// The host's view of the staged bundles (spec `docs/designs/grpc-processes.md`,
// section 7 "Spawn", section 8 "Descriptors", section 14 "Staging"): the
// command of a bundle (A64) and the catalog index of their descriptors, read
// from `<bundles dir>/<id>/` at run time.

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  type CatalogIndex,
  catalogIndexFromDescriptors,
} from './catalog-index.js';
import type { SpawnCommand } from './supervisor/spawn.js';

/**
 * The host's `commandOf` (A64) over the bundles staged in `bundlesDir`. The
 * answered function reads the staged files on each call: when
 * `<bundlesDir>/<bundleId>/host/command.json` exists (written by
 * `stage --dev`): its JSON array, the first element as `command` and the
 * rest, in order, as `args`; otherwise
 * `{ command: '<bundlesDir>/<bundleId>/host/doric-<bundleId>', args: [] }`,
 * whether or not that executable exists. `bundlesDir` is resolved to an
 * absolute path when `stagedCommandOf` is called. Synchronous, as
 * `PlatformOptions.commandOf` is.
 *
 * Throws an `Error` whose message names the `command.json` path when the file
 * exists but cannot be read, is not JSON, or is not a non-empty array of
 * strings; the supervisor then quarantines the bundle with `invalid_bundle`
 * and that message. Reads only.
 */
export const stagedCommandOf = (
  bundlesDir: string,
): ((bundleId: string) => SpawnCommand) => {
  const root = resolve(bundlesDir);

  return (bundleId) => {
    const host = join(root, bundleId, 'host');
    const path = join(host, 'command.json');

    if (!existsSync(path)) {
      return { command: join(host, `doric-${bundleId}`), args: [] };
    }

    let value: unknown;

    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`${path}: ${messageOf(error)}`);
    }

    if (!isStrings(value) || value[0] === undefined) {
      throw new Error(`${path}: not a non-empty array of strings.`);
    }

    const [command, ...args] = value;

    return { command, args };
  };
};

const isStrings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((part) => typeof part === 'string');

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The catalog index of the staged bundles `ids`: `catalogIndexFromDescriptors`
 * over the bytes of `<bundlesDir>/<id>/descriptors.binpb` of each id, in the
 * order of `ids`; a repeated id counts once, empty `ids` answer an empty
 * index. A missing file is an error.
 *
 * Rejects with an `Error` naming the path when a file is missing, cannot be
 * read, or is not a binary `FileDescriptorSet`; and with
 * `catalogIndexFromDescriptors`' `TypeError` naming the `.proto` file when the
 * sets together break a rule of the index. Reads only, each file once.
 */
export const readStagedCatalogIndex = async (
  bundlesDir: string,
  ids: readonly string[],
): Promise<CatalogIndex> => {
  const sets: Uint8Array[] = [];
  const paths: string[] = [];

  for (const id of new Set(ids)) {
    const path = join(resolve(bundlesDir), id, 'descriptors.binpb');

    try {
      sets.push(await readFile(path));
    } catch (error) {
      throw new Error(`${path}: ${messageOf(error)}`);
    }

    paths.push(path);
  }

  try {
    return catalogIndexFromDescriptors(sets);
  } catch (error) {
    const position = /^descriptor set (\d+):/.exec(messageOf(error))?.[1];
    const path = position === undefined ? undefined : paths[Number(position)];

    if (path !== undefined) {
      throw new Error(`${path}: ${messageOf(error)}`);
    }

    throw error;
  }
};
