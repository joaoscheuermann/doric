import type { ModelKindDescriptor, ModelsProvider } from 'bundle/contracts';

/** One registered kind: its provider record and the descriptor it reported. */
export interface KindEntry {
  readonly api: ModelsProvider;
  readonly kind: ModelKindDescriptor;
  readonly advertised: boolean;
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
        read: Promise.all([api.kind(), api.advertised()]).then(
          ([kind, advertised]) => ({ api, kind, advertised }),
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
