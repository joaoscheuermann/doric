import type { ModelKindDescriptor, ModelsProvider } from 'bundle/contracts';

/** One registered kind: its provider record and the descriptor it reported. */
export interface KindEntry {
  readonly api: ModelsProvider;
  readonly kind: ModelKindDescriptor;
  readonly advertised: boolean;
  /** Whether its providers report context capacity (`catalogCapacity()`). */
  readonly catalogCapacity: boolean;
}

interface Slot {
  readonly api: ModelsProvider;
  readonly read: Promise<KindEntry | undefined>;
}

export interface KindRegistry {
  /** Adds a provider record and reads its descriptor once; returns the removal. */
  add(api: ModelsProvider): () => void;
  /** Every kind whose descriptor could be read, in registration order. */
  entries(): Promise<readonly KindEntry[]>;
  /** The first registered kind with this id, advertised or not. */
  find(id: string): Promise<KindEntry | undefined>;
}

/**
 * A record's `catalogCapacity()` (models.provider/v1 1.1.0); a provider that
 * fails to answer reports none rather than losing its kind.
 */
const capacityOf = async (api: ModelsProvider): Promise<boolean> => {
  try {
    return (await api.catalogCapacity()) === true;
  } catch {
    return false;
  }
};

/**
 * The `models.provider/v1` records in registration order. Each record's
 * descriptor is read once, when `whenAvailable` reports it, and kept in the
 * record's place, so the order is the registration order and not the order
 * in which the (asynchronous) reads resolve. A record whose descriptor cannot
 * be read is left out.
 */
export const createKindRegistry = (
  onRemoved: (api: ModelsProvider) => void,
): KindRegistry => {
  const slots: Slot[] = [];
  const entries = async (): Promise<readonly KindEntry[]> =>
    (await Promise.all(slots.map(({ read }) => read))).filter(
      (entry): entry is KindEntry => entry !== undefined,
    );

  return {
    add: (api) => {
      const slot: Slot = {
        api,
        read: Promise.all([api.kind(), api.advertised(), capacityOf(api)]).then(
          ([kind, advertised, catalogCapacity]) => ({
            api,
            kind,
            advertised,
            catalogCapacity,
          }),
          () => undefined,
        ),
      };

      slots.push(slot);

      return () => {
        const index = slots.indexOf(slot);

        if (index >= 0) {
          slots.splice(index, 1);
        }

        onRemoved(api);
      };
    },
    entries,
    find: async (id) => (await entries()).find((entry) => entry.kind.id === id),
  };
};
