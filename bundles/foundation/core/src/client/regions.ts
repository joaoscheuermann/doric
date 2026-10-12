// The core's client regions/v1 (stage 9, §4.5): named slots of items other
// bundles add. Items are sorted by `order` (absent last), then by add order;
// `items()` returns the same array until the region changes.

import {
  type Call,
  ContractError,
  defineMethod,
  defineService,
  type RegionEntry,
  type RegionItem,
  RegionsV1,
  regionsMethods,
} from 'bundle/contracts';

import { once } from './disposable.js';

interface Stored {
  readonly entry: RegionEntry;
  readonly seq: number;
}

interface Region {
  readonly stored: Stored[];
  sorted: readonly RegionEntry[];
  readonly listeners: Set<() => void>;
}

const EMPTY: readonly RegionEntry[] = Object.freeze([]);

export const createRegions = () => {
  const regions = new Map<string, Region>();
  let seq = 0;

  const regionOf = (name: string): Region => {
    let region = regions.get(name);

    if (region === undefined) {
      region = { stored: [], sorted: EMPTY, listeners: new Set() };
      regions.set(name, region);
    }

    return region;
  };

  const changed = (region: Region) => {
    region.sorted = Object.freeze(
      [...region.stored]
        .sort(
          (left, right) =>
            (left.entry.order ?? Number.POSITIVE_INFINITY) -
              (right.entry.order ?? Number.POSITIVE_INFINITY) ||
            left.seq - right.seq,
        )
        .map(({ entry }) => entry),
    );

    for (const listener of [...region.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Doric: a region listener failed:', error);
      }
    }
  };

  return defineService(RegionsV1, {
    add: defineMethod({
      input: regionsMethods.add.input,
      output: regionsMethods.add.output,
      execute: ([name, item]: [string, RegionItem], call: Call) => {
        const region = regionOf(name);

        if (region.stored.some(({ entry }) => entry.id === item.id)) {
          throw new ContractError(
            'registration_conflict',
            `The region "${name}" already has an item "${item.id}".`,
            { region: name, id: item.id },
          );
        }

        const stored: Stored = {
          entry: Object.freeze({ ...item, owner: call.caller.bundleId }),
          seq: seq++,
        };

        region.stored.push(stored);
        changed(region);

        return once(() => {
          const index = region.stored.indexOf(stored);

          if (index >= 0) {
            region.stored.splice(index, 1);
            changed(region);
          }
        });
      },
    }),
    items: defineMethod({
      input: regionsMethods.items.input,
      output: regionsMethods.items.output,
      execute: (name: string) => regions.get(name)?.sorted ?? EMPTY,
    }),
    subscribe: defineMethod({
      input: regionsMethods.subscribe.input,
      output: regionsMethods.subscribe.output,
      execute: ([name, listener]: [string, () => void]) => {
        const region = regionOf(name);

        region.listeners.add(listener);

        return once(() => region.listeners.delete(listener));
      },
    }),
  });
};
