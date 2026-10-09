import {
  ContractError,
  type Disposable,
  type SettingsDefinition,
  type SettingsEntry,
} from 'bundle/contracts';

import { once } from '../state.js';

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
  get(id: string): SpaceEntry | undefined;
  /** The registered space, or `unknown_settings`. */
  require(id: string): SpaceEntry;
  register(
    definition: SettingsDefinition,
    owner: string,
    version: string,
  ): Disposable;
}

/**
 * The facade's spaces by ID. Stage 4 partitions the entries by generation
 * (D4-11); in one process every entry belongs to generation 0.
 */
export const createSpaceRegistry = (): SpaceRegistry => {
  const spaces = new Map<string, SpaceEntry>();

  return {
    get: (id) => spaces.get(id),
    require: (id) => {
      const space = spaces.get(id);

      if (space === undefined) {
        throw new ContractError(
          'unknown_settings',
          `Settings ${id} are not registered.`,
          { settings: id },
        );
      }

      return space;
    },
    register: (definition, owner, version) => {
      const current = spaces.get(definition.id);

      if (current !== undefined) {
        throw new ContractError(
          'registration_conflict',
          `Settings ${definition.id} are already registered by "${current.owner}".`,
          { settings: definition.id, owner: current.owner },
        );
      }

      const space: SpaceEntry = {
        definition,
        owner,
        version,
        listeners: new Set(),
      };

      spaces.set(definition.id, space);

      return once(() => {
        if (spaces.get(definition.id) === space) {
          spaces.delete(definition.id);
        }
      });
    },
  };
};
