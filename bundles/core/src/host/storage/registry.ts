import {
  ContractError,
  type Disposable,
  type StorageTypeDefinition,
} from 'bundle/contracts';

import { once } from '../state.js';

/** One defined type: its definition, owner and deferred backend declaration. */
export interface TypeEntry {
  readonly definition: StorageTypeDefinition;
  readonly owner: string;
  readonly fingerprint: string;
  /** The pending or settled `declareType`; a failure clears it. */
  declared?: Promise<void>;
}

export interface TypeRegistry {
  get(type: string): TypeEntry | undefined;
  /**
   * Registers a type for its owner. The same owner with the same fingerprint
   * gets another handle; the type leaves when every handle is disposed.
   */
  register(
    definition: StorageTypeDefinition,
    owner: string,
    fingerprint: string,
  ): Disposable;
}

/**
 * The facade's types by ID. Stage 4 partitions the entries by generation
 * (D4-11); in one process every entry belongs to generation 0.
 */
export const createTypeRegistry = (): TypeRegistry => {
  const entries = new Map<string, { entry: TypeEntry; handles: number }>();

  return {
    get: (type) => entries.get(type)?.entry,
    register: (definition, owner, fingerprint) => {
      const current = entries.get(definition.type);

      if (current !== undefined) {
        if (
          current.entry.owner !== owner ||
          current.entry.fingerprint !== fingerprint
        ) {
          throw new ContractError(
            'registration_conflict',
            current.entry.owner === owner
              ? `Storage type ${definition.type} is already defined by "${owner}" with another schema or indexes.`
              : `Storage type ${definition.type} is already defined by "${current.entry.owner}".`,
            { type: definition.type, owner: current.entry.owner },
          );
        }

        current.handles += 1;
      } else {
        entries.set(definition.type, {
          entry: { definition, owner, fingerprint },
          handles: 1,
        });
      }

      const registered = entries.get(definition.type);

      return once(() => {
        if (registered === undefined) {
          return;
        }

        registered.handles -= 1;

        if (
          registered.handles === 0 &&
          entries.get(definition.type) === registered
        ) {
          entries.delete(definition.type);
        }
      });
    },
  };
};
