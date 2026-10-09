import {
  ContractError,
  type Disposable,
  type EventDefinition,
} from 'bundle/contracts';

import { once } from '../state.js';

/** One registered event type and the bundle that owns it. */
export interface EventEntry {
  readonly definition: EventDefinition;
  readonly owner: string;
}

export interface EventRegistry {
  /** The registered type, or `unknown_event`. */
  require(type: string): EventEntry;
  register(definition: EventDefinition, owner: string): Disposable;
}

/**
 * The facade's event types by ID. Stage 4 partitions the entries by
 * generation (D4-11); in one process every entry belongs to generation 0.
 */
export const createEventRegistry = (): EventRegistry => {
  const events = new Map<string, EventEntry>();

  return {
    require: (type) => {
      const entry = events.get(type);

      if (entry === undefined) {
        throw new ContractError(
          'unknown_event',
          `Event ${type} is not registered.`,
          { type },
        );
      }

      return entry;
    },
    register: (definition, owner) => {
      const current = events.get(definition.type);

      if (current !== undefined) {
        throw new ContractError(
          'registration_conflict',
          `Event ${definition.type} is already registered by "${current.owner}".`,
          { type: definition.type, owner: current.owner },
        );
      }

      const entry: EventEntry = { definition, owner };

      events.set(definition.type, entry);

      return once(() => {
        if (events.get(definition.type) === entry) {
          events.delete(definition.type);
        }
      });
    },
  };
};
