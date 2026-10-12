import {
  ContractError,
  type Disposable,
  type EventDefinition,
} from 'bundle/contracts';

import { collidesIn, seenBy, type View } from '../../shared/partition.js';
import { once } from '../../shared/state.js';

/** One registered event type and the bundle that owns it. */
export interface EventEntry {
  readonly definition: EventDefinition;
  readonly owner: string;
}

export interface EventRegistry {
  /** The type as `view` sees it, or `unknown_event`. */
  require(type: string, view: View): EventEntry;
  /** Registers a type for its owner in the partition of `view`. */
  register(definition: EventDefinition, owner: string, view: View): Disposable;
}

interface Slot {
  readonly entry: EventEntry;
  readonly generation: number;
}

/**
 * The facade's event types by `(ID, generation)` (D4-11): the same owner may
 * register the same type once per generation, and disposing one generation's
 * type never removes another's. In one process every entry belongs to
 * generation 0.
 */
export const createEventRegistry = (): EventRegistry => {
  const events = new Map<string, Slot[]>();

  return {
    require: (type, view) => {
      const entry = events
        .get(type)
        ?.find((slot) => seenBy(slot.generation, view))?.entry;

      if (entry === undefined) {
        throw new ContractError(
          'unknown_event',
          `Event ${type} is not registered.`,
          { type },
        );
      }

      return entry;
    },
    register: (definition, owner, view) => {
      const list = events.get(definition.type) ?? [];
      const current = list.find((slot) => collidesIn(slot.generation, view));

      if (current !== undefined) {
        throw new ContractError(
          'registration_conflict',
          `Event ${definition.type} is already registered by "${current.entry.owner}".`,
          { type: definition.type, owner: current.entry.owner },
        );
      }

      const slot: Slot = {
        entry: { definition, owner },
        generation: view.generation,
      };

      events.set(definition.type, [...list, slot]);

      return once(() => {
        const remaining = (events.get(definition.type) ?? []).filter(
          (item) => item !== slot,
        );

        if (remaining.length === 0) {
          events.delete(definition.type);
        } else {
          events.set(definition.type, remaining);
        }
      });
    },
  };
};
