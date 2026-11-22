// The supervision timings (spec `docs/designs/grpc-processes.md`, section 7,
// "Timings", D14): constants of the platform. No composition, manifest or
// environment setting changes them; only tests pass shorter values, through
// the `timings` option of the router and the supervisor.

import { availableParallelism } from 'node:os';

/**
 * One value per row of the spec's timings table. Durations are milliseconds.
 * The shape is an interface, not `typeof timings`, so that a test may pass
 * `{ ...timings, healthTimeoutMs: 50 }`.
 */
export interface Timings {
  /** Hello timeout: from an instance's spawn to its `Hello`. */
  readonly helloTimeoutMs: number;
  /** Spawn concurrency: instances in the state `spawned` at once. */
  readonly spawnConcurrency: number;
  /** Activation timeout: from `Activate` to its `ActivateResult`. */
  readonly activationTimeoutMs: number;
  /** Health interval: between two `HealthCheck`s of one instance. */
  readonly healthIntervalMs: number;
  /** Health timeout: from a `HealthCheck` to its `HealthReply`. */
  readonly healthTimeoutMs: number;
  /**
   * Stall threshold: a health timer that fires later than this after its due
   * time means the host's own loop was blocked (`host_stalled`).
   */
  readonly stallThresholdMs: number;
  /** Replay timeout: from `ProviderChanged` to the last `ReplayDone`. */
  readonly replayTimeoutMs: number;
  /**
   * Restart delays: the delay before the first, second and third restart of
   * a lost instance within the restart window. Its length is the number of
   * restarts allowed; the next loss quarantines with `process_failed`.
   */
  readonly restartDelaysMs: readonly number[];
  /** Restart window: the period over which losses are counted. */
  readonly restartWindowMs: number;
  /** Stop timeout: from `Stop` to the process's exit, then `SIGKILL`. */
  readonly stopTimeoutMs: number;
  /** Shutdown deadline: the whole host shutdown, then `SIGKILL` for all. */
  readonly shutdownDeadlineMs: number;
  /** Drain deadline: a draining instance's calls are cancelled after it. */
  readonly drainDeadlineMs: number;
  /**
   * Active wait: how long a call without a deadline waits for its provider's
   * bundle to have an active instance, then `unavailable` (section 3, step
   * 4). A call with a deadline waits until it.
   */
  readonly activeWaitMs: number;
}

/** The platform's timings, the values of the spec's table. */
export const timings: Timings = {
  helloTimeoutMs: 10_000,
  spawnConcurrency: Math.max(4, availableParallelism()),
  activationTimeoutMs: 60_000,
  healthIntervalMs: 5_000,
  healthTimeoutMs: 15_000,
  stallThresholdMs: 1_000,
  replayTimeoutMs: 10_000,
  restartDelaysMs: [1_000, 2_000, 4_000],
  restartWindowMs: 10 * 60_000,
  stopTimeoutMs: 10_000,
  shutdownDeadlineMs: 25_000,
  drainDeadlineMs: 10 * 60_000,
  activeWaitMs: 30_000,
};
