import {
  defineMethod,
  defineService,
  type Services,
  StorageBackendV1,
  type StorageCapabilities,
  storageBackendMethods,
} from 'bundle/contracts';
import { defaultStorageCapabilities } from 'storage';

import type { Database } from '../../prisma.js';
import type { DiskMeasurement, Environment } from '../options.js';
import { getBlob, putBlob } from './blobs.js';
import { commit } from './commit.js';
import { declareType } from './declare.js';
import { feed } from './feed.js';
import { health } from './health.js';
import { identity } from './identity.js';
import { get, query } from './query.js';
import { read } from './streams.js';

export interface StorageBackendOptions {
  readonly environment: Environment;
  readonly limits?: Partial<StorageCapabilities>;
  readonly statfs?: (path: string) => Promise<DiskMeasurement>;
  /** `connect`: the start step of this backend (see `../start.ts`). */
  readonly connect?: (services: Pick<Services, 'use'>) => Promise<void>;
}

/**
 * `storage.backend/v1` on PostgreSQL: versioned documents with declared
 * indexes, streams with gaps and truncation marks, atomic commits, the
 * commit feed, blobs, capabilities, health and the storage identity. Every
 * method but `health` and `capabilities` runs on the process's client.
 */
export const storageBackend = (
  database: () => Database,
  options: StorageBackendOptions,
) => {
  const limits: StorageCapabilities = {
    ...defaultStorageCapabilities,
    ...options.limits,
  };
  const methods = storageBackendMethods;
  // The client is taken inside the promise, so a missing URL is a rejection.
  const on = <T>(work: (client: Database) => Promise<T>): Promise<T> =>
    Promise.resolve().then(() => work(database()));

  return defineService(StorageBackendV1, {
    declareType: defineMethod({
      ...methods.declareType,
      execute: (declaration) =>
        on((client) => declareType(client, declaration)),
    }),
    get: defineMethod({
      ...methods.get,
      execute: (key) => on((client) => get(client, key)),
    }),
    query: defineMethod({
      ...methods.query,
      execute: (request) => on((client) => query(client, request)),
    }),
    read: defineMethod({
      ...methods.read,
      execute: (request) => on((client) => read(client, request)),
    }),
    commit: defineMethod({
      ...methods.commit,
      execute: (batch) => on((client) => commit(client, batch, limits)),
    }),
    feed: defineMethod({
      ...methods.feed,
      execute: (request) => on((client) => feed(client, request)),
    }),
    putBlob: defineMethod({
      ...methods.putBlob,
      execute: (bytes) => on((client) => putBlob(client, bytes)),
    }),
    getBlob: defineMethod({
      ...methods.getBlob,
      execute: (hash) => on((client) => getBlob(client, hash)),
    }),
    capabilities: defineMethod({
      ...methods.capabilities,
      execute: () => Promise.resolve({ ...limits }),
    }),
    health: defineMethod({
      ...methods.health,
      execute: () => health(options.environment, options.statfs),
    }),
    identity: defineMethod({
      ...methods.identity,
      execute: () => on(identity),
    }),
    connect: defineMethod({
      ...methods.connect,
      execute: (_input, _call, services) =>
        options.connect === undefined
          ? Promise.resolve()
          : options.connect(services),
    }),
  });
};
