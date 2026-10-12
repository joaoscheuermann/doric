import {
  type Call,
  DoricCatalogV1,
  generationOf,
  type Services,
} from 'bundle/contracts';

/**
 * The generation view of one call (D4-11). Registrations made with
 * `generation === 0` belong to the kernel partition and are visible in every
 * view; registrations made with `generation > 0` belong to that generation.
 */
export interface View {
  /** `generationOf(call)`: the partition a registration of this call joins. */
  readonly generation: number;
  /**
   * The generation whose registrations a read of this call sees besides the
   * kernel partition: the call's own, or the active one for a kernel call.
   * Read lazily, so a view that only meets kernel entries never reads the
   * catalog.
   */
  readonly reads: () => number;
}

/** The view of `call`; the active generation comes from `doric.catalog/v1`. */
export const viewOf = (call: Call, services: Services): View => {
  const generation = generationOf(call);
  let active: number | undefined;

  return {
    generation,
    reads: () => {
      if (generation !== 0) {
        return generation;
      }

      active ??= services.use(DoricCatalogV1).get(call).generation;

      return active;
    },
  };
};

/** Whether a read in `view` sees an entry registered in `entryGeneration`. */
export const seenBy = (entryGeneration: number, view: View): boolean =>
  entryGeneration === 0 || entryGeneration === view.reads();

/**
 * Whether a registration in `view` collides with a live entry registered in
 * `entryGeneration`: a kernel registration collides with every live entry,
 * a generation registration with the kernel partition and its own generation.
 */
export const collidesIn = (entryGeneration: number, view: View): boolean =>
  view.generation === 0 ||
  entryGeneration === 0 ||
  entryGeneration === view.generation;
