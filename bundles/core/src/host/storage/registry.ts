import {
  ContractError,
  type Disposable,
  type StorageTypeDefinition,
} from 'bundle/contracts';

import { collidesIn, seenBy, type View } from '../partition.js';
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
  /** The type as `view` sees it: the kernel partition, then its generation. */
  get(type: string, view: View): TypeEntry | undefined;
  /**
   * Registers a type for its owner in the partition of `view`. The same
   * owner with the same fingerprint gets another handle; the type leaves
   * when every handle is disposed.
   */
  register(
    definition: StorageTypeDefinition,
    owner: string,
    fingerprint: string,
    view: View,
  ): Disposable;
}

interface Slot {
  readonly entry: TypeEntry;
  readonly generation: number;
  handles: number;
}

/**
 * The facade's types by `(ID, generation)` (D4-11): the same owner may define
 * the same type once per generation, and disposing one generation's type
 * never removes another's. In one process every entry belongs to generation 0.
 */
export const createTypeRegistry = (): TypeRegistry => {
  const slots = new Map<string, Slot[]>();

  return {
    get: (type, view) =>
      slots.get(type)?.find((slot) => seenBy(slot.generation, view))?.entry,
    register: (definition, owner, fingerprint, view) => {
      const list = slots.get(definition.type) ?? [];
      const current = list.find((slot) => collidesIn(slot.generation, view));
      let registered: Slot;

      if (current !== undefined) {
        if (
          current.entry.owner !== owner ||
          current.entry.fingerprint !== fingerprint ||
          current.generation !== view.generation
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
        registered = current;
      } else {
        registered = {
          entry: { definition, owner, fingerprint },
          generation: view.generation,
          handles: 1,
        };
        slots.set(definition.type, [...list, registered]);
      }

      return once(() => {
        registered.handles -= 1;

        if (registered.handles === 0) {
          const remaining = (slots.get(definition.type) ?? []).filter(
            (slot) => slot !== registered,
          );

          if (remaining.length === 0) {
            slots.delete(definition.type);
          } else {
            slots.set(definition.type, remaining);
          }
        }
      });
    },
  };
};
