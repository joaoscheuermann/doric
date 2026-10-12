import {
  ContractError,
  type Disposable,
  type EventSinkSpec,
} from 'bundle/contracts';

import { collidesIn, seenBy, type View } from '../../shared/partition.js';
import { once } from '../../shared/state.js';

/** The sink of the events/v1 provider and the bundle that registered it. */
export interface EventSinkEntry {
  readonly spec: EventSinkSpec;
  readonly owner: string;
}

export interface EventSinks {
  /** The sink as `view` sees it, or `invalid_scope` when none is registered. */
  require(type: string, view: View): EventSinkEntry;
  /** Registers the sink for its owner in the partition of `view`. */
  register(spec: EventSinkSpec, owner: string, view: View): Disposable;
}

interface Slot {
  readonly entry: EventSinkEntry;
  readonly generation: number;
}

/**
 * The single sink of events/v1 per generation (cardinality one, as the
 * registry of event types): a registration collides with a live sink of the
 * kernel partition or of its own generation, and disposing one never removes
 * another's.
 */
export const createEventSinks = (): EventSinks => {
  let slots: readonly Slot[] = [];

  return {
    require: (type, view) => {
      const entry = slots.find((slot) => seenBy(slot.generation, view))?.entry;

      if (entry === undefined) {
        throw new ContractError(
          'invalid_scope',
          `Event ${type} has no event sink to write to.`,
          { type },
        );
      }

      return entry;
    },
    register: (spec, owner, view) => {
      const current = slots.find((slot) => collidesIn(slot.generation, view));

      if (current !== undefined) {
        throw new ContractError(
          'registration_conflict',
          `An event sink is already registered by "${current.entry.owner}".`,
          { owner: current.entry.owner },
        );
      }

      const slot: Slot = {
        entry: { spec, owner },
        generation: view.generation,
      };

      slots = [...slots, slot];

      return once(() => {
        slots = slots.filter((item) => item !== slot);
      });
    },
  };
};

/**
 * The stream of one row: each `{key}` placeholder takes the value of that
 * key in `scope`. The keys are checked by the sink schema and the values by
 * the caller, so every placeholder has a value here.
 */
export const streamOf = (
  spec: EventSinkSpec,
  scope: Readonly<Record<string, string>>,
): string =>
  spec.stream.replace(/\{([^{}]*)\}/g, (_, key: string) => scope[key] ?? '');
