import { createTestServices } from 'bundle';
import { type StorageBackend, StorageBackendV1 } from 'bundle/contracts';

import type {
  ConformanceHarness,
  ConformanceInstance,
} from '../../src/conformance/index.js';
import {
  createMemoryStore,
  type MemoryStore,
  memoryStorageBackend,
} from '../../src/memory/index.js';

export interface MemoryInstance extends ConformanceInstance {
  dispose(): Promise<void>;
}

/**
 * The memory harness of the conformance kit. Every instance serves the
 * harness's current store through the real dispatcher; `reset` starts a new
 * store, and a crash drops an instance while the store survives it.
 * `wrap` lets a test change what an instance's backend does.
 */
export const memoryHarness = (
  options: {
    readonly name?: string;
    readonly wrap?: (
      backend: StorageBackend,
      store: MemoryStore,
    ) => StorageBackend;
  } = {},
): ConformanceHarness<MemoryInstance> => {
  let store = createMemoryStore();

  return {
    name: options.name ?? 'memory',
    open: async ({ limits } = {}) => {
      const services = createTestServices({
        bundle: { id: 'storage-test' },
        provide: [
          memoryStorageBackend(store, limits === undefined ? {} : { limits }),
        ],
      });
      const backend = services.services.use(StorageBackendV1);

      return {
        backend: options.wrap?.(backend, store) ?? backend,
        dispose: () => services.dispose(),
      };
    },
    reset: async () => {
      store = createMemoryStore();
    },
    crash: (instance) => instance.dispose(),
    close: (instance) => instance.dispose(),
  };
};
