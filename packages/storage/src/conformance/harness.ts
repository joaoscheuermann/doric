import type { StorageBackend, StorageCapabilities } from 'bundle/contracts';

/** One open backend instance. */
export interface ConformanceInstance {
  /** The backend, reached through the real dispatcher so every call is validated. */
  readonly backend: StorageBackend;
}

export interface ConformanceOpenOptions {
  /** Overrides of the backend's default capabilities. */
  readonly limits?: Partial<StorageCapabilities>;
}

/**
 * What a backend's test suite gives the kit. Every instance a harness opens
 * serves the same underlying store, so data one instance commits is visible
 * to the others, and to an instance opened after another one crashed.
 */
export interface ConformanceHarness<
  Instance extends ConformanceInstance = ConformanceInstance,
> {
  /** The backend's name, used in suite titles. */
  readonly name: string;
  /** Opens a new backend instance over the same underlying store. */
  open(options?: ConformanceOpenOptions): Promise<Instance>;
  /** Empties the store between cases. */
  reset(): Promise<void>;
  /** Abandons an instance without a graceful close, as if its process died. */
  crash(instance: Instance): Promise<void>;
  /** Closes an instance gracefully. */
  close(instance: Instance): Promise<void>;
}

/** One conformance case: a behavior of `storage.backend/v1` and its proof. */
export interface ConformanceCase {
  /** A stable ID such as `D1` or `X3`. */
  readonly id: string;
  /** The group the case belongs to, one test suite per group. */
  readonly group: string;
  readonly title: string;
  /**
   * Runs the case over an empty store. Instances it opens and does not close
   * or crash are closed when it ends.
   */
  run(harness: ConformanceHarness): Promise<void>;
}

/** Defines the cases of one group. */
export const caseGroup =
  (group: string) =>
  (
    id: string,
    title: string,
    run: (harness: ConformanceHarness) => Promise<void>,
  ): ConformanceCase => ({ id, group, title, run });
