import type { EmbeddedBundle } from 'bundle';
import type { HostContext } from 'bundle/contracts';

import {
  type MemorySecretsOptions,
  memorySecretsBackend,
} from './secrets-backend.js';
import {
  type MemoryStorageOptions,
  memoryStorageBackend,
} from './storage-backend.js';
import { createMemoryStore, type MemoryStore } from './store.js';

export interface MemoryFoundationOptions {
  /** The store to serve; a new one by default. */
  readonly store?: MemoryStore;
  readonly storage?: MemoryStorageOptions;
  readonly secrets?: MemorySecretsOptions;
  /** The bundle ID, `memory` by default. */
  readonly id?: string;
}

const contracts = ['storage.backend/v1', 'secrets.backend/v1'] as const;
const version = '1.0.0';

/**
 * An embedded foundation bundle that provides both backends in memory. The
 * composition still has to choose it in `providers` for each contract.
 */
export const memoryFoundation = (
  options: MemoryFoundationOptions = {},
): EmbeddedBundle => {
  const id = options.id ?? 'memory';
  const store = options.store ?? createMemoryStore();

  return {
    manifest: {
      manifestVersion: 1,
      id,
      version,
      engines: { doric: '^1.0.0' },
      description: 'In-memory storage and secrets backends for tests.',
      provides: contracts.map((contract) => `${contract}@${version}`),
      requires: [],
    },
    descriptor: {
      descriptorVersion: 1,
      bundle: { id, version },
      contracts: contracts.map((contract) => ({
        id: contract,
        version,
        kind: 'service' as const,
        environment: 'host' as const,
        cardinality: 'one' as const,
        local: false,
        schema: `schemas/${contract}.json`,
      })),
    },
    host: {
      activate: ({ services }: HostContext) => {
        services.provide(memoryStorageBackend(store, options.storage));
        services.provide(memorySecretsBackend(options.secrets));
      },
    },
  };
};
