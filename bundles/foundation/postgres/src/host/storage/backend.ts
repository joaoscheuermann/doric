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
import { deleteBlob, getBlob, putBlob } from './blobs.js';
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
 * The storage operations on PostgreSQL, on parsed inputs: the method bodies
 * of `storageBackend` but `connect`, shared with the host part's plain
 * backend (`../backends.ts`). Every operation but `health` and
 * `capabilities` runs on the process's client, taken inside the promise so a
 * missing URL is a rejection.
 */
export const storageOperations = (
  database: () => Database,
  options: Omit<StorageBackendOptions, 'connect'>,
) => {
  const limits: StorageCapabilities = {
    ...defaultStorageCapabilities,
    ...options.limits,
  };
  const on = <T>(work: (client: Database) => Promise<T>): Promise<T> =>
    Promise.resolve().then(() => work(database()));

  return {
    declareType: (declaration: Parameters<typeof declareType>[1]) =>
      on((client) => declareType(client, declaration)),
    get: (key: Parameters<typeof get>[1]) => on((client) => get(client, key)),
    query: (request: Parameters<typeof query>[1]) =>
      on((client) => query(client, request)),
    read: (request: Parameters<typeof read>[1]) =>
      on((client) => read(client, request)),
    commit: (batch: Parameters<typeof commit>[1]) =>
      on((client) => commit(client, batch, limits)),
    feed: (request: Parameters<typeof feed>[1]) =>
      on((client) => feed(client, request)),
    putBlob: (bytes: string) => on((client) => putBlob(client, bytes)),
    getBlob: (hash: string) => on((client) => getBlob(client, hash)),
    deleteBlob: (hash: string) => on((client) => deleteBlob(client, hash)),
    capabilities: (): Promise<StorageCapabilities> =>
      Promise.resolve({ ...limits }),
    health: () => health(options.environment, options.statfs),
    identity: () => on(identity),
  };
};

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
  const operations = storageOperations(database, options);
  const methods = storageBackendMethods;

  return defineService(StorageBackendV1, {
    declareType: defineMethod({
      ...methods.declareType,
      execute: (declaration) => operations.declareType(declaration),
    }),
    get: defineMethod({
      ...methods.get,
      execute: (key) => operations.get(key),
    }),
    query: defineMethod({
      ...methods.query,
      execute: (request) => operations.query(request),
    }),
    read: defineMethod({
      ...methods.read,
      execute: (request) => operations.read(request),
    }),
    commit: defineMethod({
      ...methods.commit,
      execute: (batch) => operations.commit(batch),
    }),
    feed: defineMethod({
      ...methods.feed,
      execute: (request) => operations.feed(request),
    }),
    putBlob: defineMethod({
      ...methods.putBlob,
      execute: (bytes) => operations.putBlob(bytes),
    }),
    getBlob: defineMethod({
      ...methods.getBlob,
      execute: (hash) => operations.getBlob(hash),
    }),
    deleteBlob: defineMethod({
      ...methods.deleteBlob,
      execute: (hash) => operations.deleteBlob(hash),
    }),
    capabilities: defineMethod({
      ...methods.capabilities,
      execute: () => operations.capabilities(),
    }),
    health: defineMethod({
      ...methods.health,
      execute: () => operations.health(),
    }),
    identity: defineMethod({
      ...methods.identity,
      execute: () => operations.identity(),
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
