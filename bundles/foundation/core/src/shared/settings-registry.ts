import {
  ContractError,
  type Disposable,
  type SettingsDefinition,
  type SettingsEntry,
} from 'bundle/contracts';

import { collidesIn, seenBy, type View } from './partition.js';
import { once } from './state.js';

export interface Listener {
  readonly bundleId: string;
  readonly listener: (entry: SettingsEntry) => void;
}

/** One registered space: its definition, owner and the version from `provides`. */
export interface SpaceEntry {
  readonly definition: SettingsDefinition;
  readonly owner: string;
  readonly version: string;
  readonly listeners: Set<Listener>;
}

export interface SpaceRegistry {
  /** The space as `view` sees it: the kernel partition, then its generation. */
  get(id: string, view: View): SpaceEntry | undefined;
  /** The space as `view` sees it, or `unknown_settings`. */
  require(id: string, view: View): SpaceEntry;
  /** Every live registration of the space, in every generation. */
  all(id: string): readonly SpaceEntry[];
  /** Registers a space for its owner in the partition of `view`. */
  register(
    definition: SettingsDefinition,
    owner: string,
    version: string,
    view: View,
  ): Disposable;
}

interface Slot {
  readonly space: SpaceEntry;
  readonly generation: number;
}

/**
 * The facade's spaces by `(ID, generation)` (D4-11): the same owner may
 * register the same space once per generation, and disposing one
 * generation's space never removes another's. In one process every entry
 * belongs to generation 0.
 */
export const createSpaceRegistry = (): SpaceRegistry => {
  const spaces = new Map<string, Slot[]>();

  const get = (id: string, view: View): SpaceEntry | undefined =>
    spaces.get(id)?.find((slot) => seenBy(slot.generation, view))?.space;

  return {
    get,
    require: (id, view) => {
      const space = get(id, view);

      if (space === undefined) {
        throw new ContractError(
          'unknown_settings',
          `Settings ${id} are not registered.`,
          { settings: id },
        );
      }

      return space;
    },
    all: (id) => (spaces.get(id) ?? []).map((slot) => slot.space),
    register: (definition, owner, version, view) => {
      const list = spaces.get(definition.id) ?? [];
      const current = list.find((slot) => collidesIn(slot.generation, view));

      if (current !== undefined) {
        throw new ContractError(
          'registration_conflict',
          `Settings ${definition.id} are already registered by "${current.space.owner}".`,
          { settings: definition.id, owner: current.space.owner },
        );
      }

      const slot: Slot = {
        space: { definition, owner, version, listeners: new Set() },
        generation: view.generation,
      };

      spaces.set(definition.id, [...list, slot]);

      return once(() => {
        const remaining = (spaces.get(definition.id) ?? []).filter(
          (item) => item !== slot,
        );

        if (remaining.length === 0) {
          spaces.delete(definition.id);
        } else {
          spaces.set(definition.id, remaining);
        }
      });
    },
  };
};
