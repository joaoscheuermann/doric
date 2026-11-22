// What one supervisor knows of its bundles (spec
// `docs/designs/grpc-processes.md`, sections 6 and 7), shared by its boot
// (`boot.ts`), its losses and stops (`lifecycle.ts`) and its publish target
// (`supervisor.ts`).

import type { ResolvedEnvironment } from '../../runtime/catalog.js';
import type { InstanceKey } from '../router/instances.js';
import type { BundleProcess } from './process.js';
import type { BundleGeneration } from './publish.js';
import type { SupervisorOptions } from './supervisor.js';
import type { Timings } from './timings.js';

/** A publish's new generation of a bundle, until it is active or failed. */
export interface Replacement {
  readonly generation: number;
  /** The new generation's instance became `active`. */
  readonly activated: (key: InstanceKey) => void;
  /** It did not: the message of what would have quarantined the bundle. */
  readonly fail: (message: string) => void;
}

/** A bundle's boot outcome, settled once. */
export interface Outcome {
  readonly settled: Promise<'active' | 'quarantined'>;
  settle(result: 'active' | 'quarantined'): void;
}

export const createOutcome = (): Outcome => {
  let settle: (result: 'active' | 'quarantined') => void = () => {};
  const settled = new Promise<'active' | 'quarantined'>((resolve) => {
    settle = resolve;
  });

  return { settled, settle: (result) => settle(result) };
};

/** First-come spawn slots; `close` lets every waiter through. */
export interface Slots {
  acquire(): Promise<void>;
  release(): void;
  close(): void;
}

export const createSlots = (size: number): Slots => {
  const waiters: (() => void)[] = [];
  let free = Math.max(1, size);
  let closed = false;

  return {
    acquire: () => {
      if (closed || free > 0) {
        free -= 1;

        return Promise.resolve();
      }

      return new Promise<void>((resolve) => waiters.push(resolve));
    },
    release: () => {
      const next = waiters.shift();

      if (next === undefined) {
        free += 1;
      } else {
        next();
      }
    },
    close: () => {
      closed = true;

      for (const next of waiters.splice(0)) {
        next();
      }
    },
  };
};

/** The state of one supervisor, read and changed by its parts. */
export interface SupervisorState {
  readonly options: SupervisorOptions;
  readonly timings: Timings;
  /** The resolution adopted last: `options.resolved` until a publish. */
  resolved: ResolvedEnvironment;
  entries: Map<string, ResolvedEnvironment['entries'][number]>;
  /** The `scheduled` entries of `resolved`, in its order. */
  scheduled: string[];
  /** Each bundle's running generation, in the order they were spawned. */
  readonly generations: Map<string, BundleGeneration>;
  /** Each bundle's newest generation number spawned, running or not. */
  readonly spawnedGenerations: Map<string, number>;
  /** The publish's new generation of a bundle, until it is active or failed. */
  readonly replacements: Map<string, Replacement>;
  readonly processes: Map<InstanceKey, BundleProcess>;
  /** Each bundle's current instance: its newest incarnation spawned. */
  readonly current: Map<string, InstanceKey>;
  readonly outcomes: Map<string, Outcome>;
  readonly quarantined: Set<string>;
  /** The bundles that have been `active` once: the runtime cascade's reach. */
  readonly activated: Set<string>;
  /** The times of each bundle's losses within the restart window. */
  readonly losses: Map<string, number[]>;
  /** Each bundle's scheduled restart. */
  readonly restarts: Map<string, NodeJS.Timeout>;
  readonly stops: Map<InstanceKey, Promise<void>>;
  readonly slots: Slots;
  /** Set when the shutdown starts. */
  shuttingDown: Promise<void> | undefined;
  /** Resolves when the shutdown starts. */
  readonly stopped: Promise<void>;
}

/** Adopts `resolved`: its entries and its scheduled bundles. */
export const adoptResolution = (
  state: SupervisorState,
  resolved: ResolvedEnvironment,
): void => {
  state.resolved = resolved;
  state.entries = new Map(resolved.entries.map((entry) => [entry.id, entry]));
  state.scheduled = resolved.order.filter(
    (id) => state.entries.get(id)?.state === 'scheduled',
  );
};

/** The bundle's boot outcome, created on first ask. */
export const outcomeOf = (
  state: SupervisorState,
  bundleId: string,
): Outcome => {
  let outcome = state.outcomes.get(bundleId);

  if (outcome === undefined) {
    outcome = createOutcome();
    state.outcomes.set(bundleId, outcome);
  }

  return outcome;
};

/** Cancels the bundle's scheduled restart, if any. */
export const cancelRestart = (
  state: SupervisorState,
  bundleId: string,
): void => {
  clearTimeout(state.restarts.get(bundleId));
  state.restarts.delete(bundleId);
};
