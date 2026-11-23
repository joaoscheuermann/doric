import type { Client } from '@connectrpc/connect';
import { createTestServices } from 'bundle';
import {
  type SecretsBackend,
  type StorageBackend,
  StorageBackendV1,
} from 'bundle/contracts';
import { BackendService as SecretsBackendService } from 'bundle/contracts/gen/doric/secrets/backend/v1/backend_pb.js';
import { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import { createTestRouter } from 'bundle/testing';

import type {
  ConformanceHarness,
  ConformanceInstance,
} from '../../src/conformance/index.js';
import {
  createMemoryStore,
  type MemoryStorageOptions,
  type MemoryStore,
  memoryStorageBackend,
} from '../../src/memory/index.js';
import {
  secretsBackendClient,
  serveSecretsBackend,
  serveStorageBackend,
  storageBackendClient,
} from '../../src/rpc/index.js';

/** One backend instance served through `createTestRouter`. */
export interface RouterInstance extends ConformanceInstance {
  /** Stops the router (`control.stop()`) and disposes the memory services. */
  dispose(): Promise<void>;
}

/** A `StorageBackend` served by `serveStorageBackend` on a fresh test router. */
export interface ServedStorage {
  /** `storageBackendClient` over the router's client. */
  readonly backend: StorageBackend;
  /** The router's raw Connect client of `storage.backend/v1`. */
  readonly raw: Client<typeof StorageBackendService>;
  /** Stops the router. */
  stop(): Promise<void>;
}

/**
 * Serves `backend` with `serveStorageBackend` through a fresh
 * `createTestRouter` and answers the client adapter and the raw client.
 */
export const serveStorage = async (
  backend: StorageBackend,
): Promise<ServedStorage> => {
  const router = createTestRouter();

  await router.activate({
    services: [[StorageBackendService, serveStorageBackend(backend)]],
    activate: () => {},
  });

  const raw = router.client(StorageBackendService);

  return {
    backend: storageBackendClient(raw),
    raw,
    stop: () => router.control.stop(),
  };
};

/** A `SecretsBackend` served by `serveSecretsBackend` on a fresh test router. */
export const serveSecrets = async (
  backend: SecretsBackend,
): Promise<{
  readonly backend: SecretsBackend;
  readonly raw: Client<typeof SecretsBackendService>;
  stop(): Promise<void>;
}> => {
  const router = createTestRouter();

  await router.activate({
    services: [[SecretsBackendService, serveSecretsBackend(backend)]],
    activate: () => {},
  });

  const raw = router.client(SecretsBackendService);

  return {
    backend: secretsBackendClient(raw),
    raw,
    stop: () => router.control.stop(),
  };
};

/** The memory `StorageBackend` over `store`, reached through the dispatcher. */
export const memoryBackend = (
  store: MemoryStore,
  options?: MemoryStorageOptions,
): { readonly backend: StorageBackend; dispose(): Promise<void> } => {
  const services = createTestServices({
    bundle: { id: 'storage-test' },
    provide: [memoryStorageBackend(store, options)],
  });

  return {
    backend: services.services.use(StorageBackendV1),
    dispose: () => services.dispose(),
  };
};

/**
 * The conformance harness over the router: `open` serves
 * `memoryStorageBackend(store, { limits })` (through `createTestServices`) with
 * `serveStorageBackend` on a fresh `createTestRouter`, and answers
 * `storageBackendClient(router.client(StorageBackendService))` as `backend`;
 * every instance shares the harness's current store; `reset` starts a new
 * store; `crash` and `close` dispose the instance. Name `memory over router`.
 */
export const routerHarness = (): ConformanceHarness<RouterInstance> => {
  let store = createMemoryStore();

  return {
    name: 'memory over router',
    open: async ({ limits } = {}) => {
      const memory = memoryBackend(
        store,
        limits === undefined ? {} : { limits },
      );
      const served = await serveStorage(memory.backend);

      return {
        backend: served.backend,
        dispose: async () => {
          await served.stop();
          await memory.dispose();
        },
      };
    },
    reset: async () => {
      store = createMemoryStore();
    },
    crash: (instance) => instance.dispose(),
    close: (instance) => instance.dispose(),
  };
};
