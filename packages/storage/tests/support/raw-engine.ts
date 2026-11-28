// A `sqlite` engine bundle spawned for a test as `openTestEngine` spawns it,
// but handing out its transports, so a test can send `storage/v2` requests
// that the client never sends (a value that does not decode, say) and read
// the store through `storage.kv/v1` as `doric`.

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Client, createClient } from '@connectrpc/connect';
import { KvService } from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';
import { StorageService } from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';
import { startTestProcess } from 'bundle/testing';

import { type Kv, kvClient } from '../../src/kv.js';

/** A spawned engine and its clients. */
export interface RawEngine {
  /** A raw `storage/v2` client stamped as `caller`, generation 1. */
  storage(caller: string): Client<typeof StorageService>;
  /** The engine's `Kv` of the caller `doric`. */
  readonly kv: Kv;
  /** Stops the process and removes its directory. */
  close(): Promise<void>;
}

/** The repository root: the nearest directory above this module with `nx.json`. */
const repoRoot = (): string => {
  for (
    let dir = dirname(fileURLToPath(import.meta.url));
    dirname(dir) !== dir;
    dir = dirname(dir)
  ) {
    if (existsSync(join(dir, 'nx.json'))) {
      return dir;
    }
  }

  throw new Error('no nx.json above this module');
};

/** Spawns the debug `doric-sqlite` on a new temporary directory. */
export const openRawEngine = async (): Promise<RawEngine> => {
  const dir = await mkdtemp(join(tmpdir(), 'doric-raw-engine-'));
  const engine = await startTestProcess({
    bundleId: 'sqlite',
    command: [join(repoRoot(), 'dist/target/doric-sqlite/debug/doric-sqlite')],
    env: { DORIC_STORAGE_PATH: dir },
  }).catch(async (error: unknown) => {
    await rm(dir, { recursive: true, force: true });
    throw error;
  });

  return {
    storage: (caller) => createClient(StorageService, engine.transport(caller)),
    kv: kvClient(createClient(KvService, engine.transport('doric'))),
    close: async () => {
      await engine.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
};
