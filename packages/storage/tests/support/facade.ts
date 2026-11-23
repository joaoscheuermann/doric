// A recording `StorageFacade` for the `storage/v1` adapter tests: what
// `core`'s `createStorage` does, reduced to the checks the tests observe,
// over the memory backend. `storage` cannot import `core`.

import {
  type Call,
  type CallScope,
  type CommitBatch,
  ContractError,
  type Disposable,
  type StorageBackend,
  type StorageTypeDefinition,
} from 'bundle/contracts';

import { createMemoryStore, type MemoryStore } from '../../src/memory/index.js';
import type { StorageFacade } from '../../src/rpc/index.js';
import { memoryBackend } from './router-harness.js';

/** One call a recording facade received, in arrival order. */
export interface FacadeCall {
  readonly method: keyof StorageFacade | 'dispose';
  readonly input: unknown;
  readonly caller: { readonly bundleId: string; readonly generation: number };
  /** The call's scope, absent when the call had none. */
  readonly scope?: CallScope;
}

export type MemoryFacade = StorageFacade & {
  readonly calls: readonly FacadeCall[];
  /** The definitions as the facade received them, by type. */
  readonly definitions: ReadonlyMap<string, StorageTypeDefinition>;
  /** Disposes the memory backend's services. */
  close(): Promise<void>;
};

interface Entry {
  readonly definition: StorageTypeDefinition;
  readonly owner: string;
  readonly indexes: string;
  handles: number;
}

const namespaceOf = (type: string): string => type.split(/[./]/u, 1)[0] ?? '';

/**
 * A `StorageFacade` over `memoryStorageBackend(store)` that keeps today's
 * core checks the tests need: a type defined by the bundle its namespace
 * names, else `not_owner`; the same type again with other indexes, or by
 * another bundle, is `registration_conflict` (same indexes: another handle);
 * an operation on an undefined type is `unknown_type`; each `put` value
 * parsed with the definition's schema, a failure `invalid_input` with
 * nothing applied; disposing the last handle undefines the type. Records
 * every call and dispose in `calls`.
 */
export const memoryFacade = (
  store: MemoryStore = createMemoryStore(),
): MemoryFacade => {
  const memory = memoryBackend(store);
  const backend: StorageBackend = memory.backend;
  const calls: FacadeCall[] = [];
  const types = new Map<string, Entry>();
  const definitions = new Map<string, StorageTypeDefinition>();
  const declared = new Set<string>();

  const record = (
    method: FacadeCall['method'],
    input: unknown,
    caller: { readonly bundleId: string; readonly generation: number },
    scope?: CallScope,
  ): void => {
    calls.push({
      method,
      input,
      caller: { bundleId: caller.bundleId, generation: caller.generation },
      ...(scope === undefined ? {} : { scope }),
    });
  };

  const recordCall = (method: keyof StorageFacade, input: unknown, call: Call) =>
    record(method, input, call.caller, call.scope);

  const optionsOf = (call: Call) => ({ signal: call.signal });

  const registered = (type: string, call: Call): Entry => {
    const entry = types.get(type);

    if (entry === undefined) {
      throw new ContractError(
        'unknown_type',
        `Storage type ${type} is not defined.`,
        { type },
      );
    }

    if (entry.owner !== call.caller.bundleId) {
      throw new ContractError(
        'not_owner',
        `Bundle "${call.caller.bundleId}" cannot use storage type ${type}.`,
        { type, owner: entry.owner },
      );
    }

    return entry;
  };

  const declare = async (entry: Entry, call: Call): Promise<void> => {
    const { type, indexes } = entry.definition;

    if (!declared.has(type)) {
      await backend.declareType(
        {
          type,
          indexes: indexes.map(({ name, fields, unique }) => ({
            name,
            fields: [...fields],
            ...(unique === undefined ? {} : { unique }),
          })),
        },
        optionsOf(call),
      );
      declared.add(type);
    }
  };

  return {
    calls,
    definitions,
    close: () => memory.dispose(),
    defineType: (definition, call): Disposable => {
      recordCall('defineType', definition, call);

      const owner = namespaceOf(definition.type);

      if (owner !== call.caller.bundleId) {
        throw new ContractError(
          'not_owner',
          `Bundle "${call.caller.bundleId}" cannot define storage type ${definition.type}.`,
          { type: definition.type, owner },
        );
      }

      const indexes = JSON.stringify(definition.indexes);
      const existing = types.get(definition.type);

      if (
        existing !== undefined &&
        (existing.owner !== owner || existing.indexes !== indexes)
      ) {
        throw new ContractError(
          'registration_conflict',
          `Storage type ${definition.type} is already defined differently.`,
          { type: definition.type, owner: existing.owner },
        );
      }

      const entry = existing ?? { definition, owner, indexes, handles: 0 };

      entry.handles += 1;
      types.set(definition.type, entry);
      definitions.set(definition.type, definition);

      const caller = call.caller;
      let disposed = false;

      return {
        dispose: () => {
          if (disposed) {
            return;
          }

          disposed = true;
          record('dispose', definition.type, caller);
          entry.handles -= 1;

          if (entry.handles === 0 && types.get(definition.type) === entry) {
            types.delete(definition.type);
          }
        },
      };
    },
    get: async (key, call) => {
      recordCall('get', key, call);
      await declare(registered(key.type, call), call);

      return await backend.get(key, optionsOf(call));
    },
    query: async (query, call) => {
      recordCall('query', query, call);
      await declare(registered(query.type, call), call);

      return await backend.query(query, optionsOf(call));
    },
    read: async (request, call) => {
      recordCall('read', request, call);

      return await backend.read(request, optionsOf(call));
    },
    commit: async (batch, call) => {
      recordCall('commit', batch, call);

      const touched = new Set<Entry>();
      const use = (type: string): Entry => {
        const entry = registered(type, call);

        touched.add(entry);

        return entry;
      };

      for (const key of [...(batch.expect ?? []), ...(batch.delete ?? [])]) {
        use(key.type);
      }

      const put = (batch.put ?? []).map((document) => {
        const parsed = use(document.type).definition.schema.safeParse(
          document.value,
        );

        if (!parsed.success) {
          throw new ContractError(
            'invalid_input',
            `Invalid ${document.type} document ${document.id}.`,
            { type: document.type, id: document.id },
          );
        }

        return { ...document, value: parsed.data as unknown };
      });

      for (const entry of touched) {
        await declare(entry, call);
      }

      const checked: CommitBatch = {
        ...batch,
        ...(batch.put === undefined ? {} : { put }),
      };

      return await backend.commit(checked, optionsOf(call));
    },
    health: async (call) => {
      recordCall('health', undefined, call);

      return await backend.health(optionsOf(call));
    },
    putBlob: async (bytes, call) => {
      recordCall('putBlob', bytes.length, call);

      return await backend.putBlob(bytes, optionsOf(call));
    },
    getBlob: async (hash, call) => {
      recordCall('getBlob', hash, call);

      return await backend.getBlob(hash, optionsOf(call));
    },
    deleteBlob: async (hash, call) => {
      recordCall('deleteBlob', hash, call);
      await backend.deleteBlob(hash, optionsOf(call));
    },
  };
};
