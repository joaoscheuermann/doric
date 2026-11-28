// Internal to `storage/testing` and its tests, not an entry of the package:
// `openTestEngine` with the executable as a parameter, so a test can name one
// that does not exist.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { create } from '@bufbuild/protobuf';
import { type Client, createClient } from '@connectrpc/connect';
import {
  CommitRequestSchema,
  KvService,
} from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';
import { startTestProcess, type TestProcess } from 'bundle/testing';

import { registerOver, storageOver } from './client/index.js';
import { type Kv, kvClient } from './kv.js';
import type { TestEngine, TestEngineOptions } from './testing.js';

/**
 * The repository root: the nearest directory above this module that holds
 * `nx.json`, whether the module runs from `src`, `dist` or `dist-tests/src`;
 * else the directory three levels up, `packages/storage/<dir>`'s root.
 */
const repoRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));

  for (let dir = here; dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, 'nx.json'))) {
      return dir;
    }
  }

  return join(here, '../../..');
};

/**
 * `<repo root>/dist/target/doric-sqlite/<profile>/doric-sqlite`: the debug
 * build of `npx nx run sqlite:compile`, which `openTestEngine` spawns, or with
 * `'release'` the build of `npx nx run sqlite:compile:production`, which
 * RK27's measurements spawn.
 */
export const testEngineBinary = (
  profile: 'debug' | 'release' = 'debug',
): string =>
  join(repoRoot(), 'dist/target/doric-sqlite', profile, 'doric-sqlite');

/**
 * `openTestEngine` on the executable `binary`: the same engine, directory,
 * `storage` and `close()`, with `raw(caller, generation)`, 1 when absent, a
 * raw `StorageService` client over the engine's transport stamped with
 * `{ caller, generation }`, which registers nothing. Rejects with
 * `Error('doric-sqlite is not built: run npx nx run sqlite:compile')`, and
 * spawns nothing, when no file exists at `binary`.
 */
export const openTestEngineAt = async (
  binary: string,
  options?: TestEngineOptions,
): Promise<
  TestEngine & {
    raw(caller: string, generation?: number): Client<typeof StorageService>;
  }
> => {
  if (!existsSync(binary)) {
    throw new Error('doric-sqlite is not built: run npx nx run sqlite:compile');
  }

  const made = options?.path === undefined;
  const dir =
    options?.path ?? (await mkdtemp(join(tmpdir(), 'doric-test-engine-')));
  const removeMade = async (): Promise<void> =>
    made ? rm(dir, { recursive: true, force: true }) : undefined;

  let engine: TestProcess;

  try {
    engine = await startTestProcess({
      bundleId: 'sqlite',
      command: [binary],
      env: { DORIC_STORAGE_PATH: dir },
    });
  } catch (error) {
    await removeMade();
    throw error;
  }

  const kvs = new Map<string, Kv>();
  const kv = (caller: string): Kv => {
    let found = kvs.get(caller);

    if (found === undefined) {
      found = kvClient(createClient(KvService, engine.transport(caller)));
      kvs.set(caller, found);
    }

    return found;
  };
  let closing: Promise<void> | undefined;

  return {
    kv,
    raw: (caller, generation = 1) =>
      createClient(StorageService, engine.transport(caller, generation)),
    storage: async (bundleId, files, generation = 1) => {
      const client = createClient(
        StorageService,
        engine.transport(bundleId, generation),
      );

      await registerOver(client, files);

      return storageOver(client, files);
    },
    reset: async () => {
      await kv('doric').commit([
        create(CommitRequestSchema, {
          item: {
            case: 'clearRange',
            value: { start: new Uint8Array(), end: Uint8Array.of(0xff) },
          },
        }),
      ]);
    },
    close: () => {
      closing ??= engine.stop().then(removeMade);

      return closing;
    },
  };
};
