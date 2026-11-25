import type {
  BundleState,
  DiagnosticBundle,
  DiagnosticError,
  DiagnosticReport,
  Diagnostics,
  Phase,
  QuarantineReason,
} from '../contracts/platform.js';
import type { ResolvedEnvironment } from './catalog.js';
import { partLists } from './manifest.js';

/** Recent errors kept per bundle. */
export const DIAGNOSTIC_ERRORS_PER_BUNDLE = 50;

/**
 * An instance as the platform's reports name it (section 7, "Instance
 * states"); the bundle is the report's `bundleId`.
 */
export interface ReportedInstance {
  readonly generation: number;
  readonly incarnation: number;
}

/**
 * The host's own event loop was blocked: a health timer of the instance
 * fired `delayMs` after its due time, more than the stall threshold, and the
 * router checked again instead of declaring the instance invalid (RK17).
 */
export interface HostStalledReport extends DiagnosticReport {
  readonly kind: 'host_stalled';
  readonly details: ReportedInstance & { readonly delayMs: number };
}

/**
 * An instance's process exited, or its control stream ended, without `Stop`
 * (section 7, "Crashes", step 3). `exitCode` and `signal` (its name, such
 * as `SIGSEGV`) are the process's, `null` when it had not exited when the
 * loss was recorded; `cause` is how the control stream ended.
 */
export interface GenerationLostReport extends DiagnosticReport {
  readonly kind: 'generation_lost';
  readonly details: ReportedInstance & {
    readonly cause: 'closed' | 'reset';
    readonly exitCode: number | null;
    readonly signal: string | null;
  };
}

/**
 * A new generation of the bundle did not become `active` after its restarts;
 * the previous generation stays active (section 6, "Publish", step 2).
 * `message` names the cause.
 */
export interface GenerationFailedReport extends DiagnosticReport {
  readonly kind: 'generation_failed';
  readonly details: { readonly generation: number };
}

/**
 * A consumer's replay of its registrations to a new provider instance failed
 * (`registration_replay_failed`), or the consumer did not answer
 * `ReplayDone` within the replay timeout (`registration_replay_late`), after
 * which the router released the calls it held (section 4). `bundleId` is the
 * consumer's, `details` names both instances.
 */
export interface RegistrationReplayReport extends DiagnosticReport {
  readonly kind: 'registration_replay_failed' | 'registration_replay_late';
  readonly details: ReportedInstance & {
    readonly provider: ReportedInstance & { readonly bundleId: string };
  };
}

/**
 * The reports of the gRPC platform (section 15). Each is a
 * {@link DiagnosticReport}, given to {@link DiagnosticsStore.report} and kept
 * in the bundle's list of recent errors like any other.
 */
export type PlatformReport =
  | HostStalledReport
  | GenerationLostReport
  | GenerationFailedReport
  | RegistrationReplayReport;

interface BundleRecord {
  readonly id: string;
  version: string;
  state: BundleState;
  phase?: Phase;
  readonly reasons: QuarantineReason[];
  activationMs?: number;
  /** Quarantined by its resolution's reasons, not by the supervisor. */
  resolutionQuarantine?: boolean;
}

/** The record `load` makes of a resolution entry. */
const recordOf = (
  entry: ResolvedEnvironment['entries'][number],
): BundleRecord => {
  const state: BundleState =
    entry.state === 'scheduled'
      ? 'inactive'
      : entry.state === 'disabled'
        ? 'disabled'
        : 'quarantined';

  return {
    id: entry.id,
    version: entry.version,
    state,
    ...(entry.phase === undefined ? {} : { phase: entry.phase }),
    reasons: [...entry.reasons],
    ...(state === 'quarantined' ? { resolutionQuarantine: true } : {}),
  };
};

/** Diagnostics of one environment of one generation; works without core. */
export class DiagnosticsStore {
  readonly #generation: number;
  readonly #now: () => number;
  /** Every catalog entry, duplicates included; `#byId` holds the first per ID. */
  readonly #records: BundleRecord[] = [];
  readonly #bundles = new Map<string, BundleRecord>();
  readonly #errors: DiagnosticError[] = [];
  readonly #issues: string[] = [];
  readonly #consumers = new Map<string, Set<string>>();
  #recovery: { readonly reason: string } | undefined;

  constructor(options: {
    readonly generation: number;
    readonly now?: () => number;
  }) {
    this.#generation = options.generation;
    this.#now = options.now ?? Date.now;
  }

  /** Seeds bundle states from a resolution: scheduled bundles start inactive. */
  load(resolved: ResolvedEnvironment): void {
    this.#issues.push(...resolved.issues);

    for (const entry of resolved.entries) {
      const record = recordOf(entry);

      this.#records.push(record);

      if (entry.manifest === undefined || this.#bundles.has(entry.id)) {
        // A duplicate ID, or a bundle without a readable manifest (no known
        // ID, D-35), stays visible but never receives later states.
        continue;
      }

      this.#bundles.set(entry.id, record);
      this.#indexRequires(resolved, entry);
    }

    if (resolved.recovery !== undefined) {
      this.enterRecovery(resolved.recovery.reason);
    }
  }

  /** Indexes the `requires` of a bundle `entry` that is not disabled. */
  #indexRequires(
    resolved: ResolvedEnvironment,
    entry: ResolvedEnvironment['entries'][number],
  ): void {
    if (entry.manifest === undefined || entry.state === 'disabled') {
      return;
    }

    const part = resolved.environment === 'host' ? 'host' : 'client';

    for (const required of partLists(entry.manifest, part).requires) {
      const consumers = this.#consumers.get(required.id) ?? new Set();

      consumers.add(entry.id);
      this.#consumers.set(required.id, consumers);
    }
  }

  /**
   * Follows a publish (`Platform.publish`, at `PublishTarget.adopt`): from
   * now on `snapshot()` and `state(id)` answer for the bundles of `next`,
   * one record per id, so a bundle the publish adds is listed and one it
   * removes is not. For each entry of `next` with a readable manifest, in
   * `next`'s order:
   *
   * - an id the store does not hold: recorded as `load` records it
   *   (scheduled → `inactive`, disabled → `disabled`, otherwise
   *   `quarantined` with the entry's reasons), and its `requires` indexed as
   *   `load` indexes them;
   * - an id it holds that `next` disables: `disabled`, with `next`'s reasons;
   * - an id it holds that `next` quarantines (a resolution reason):
   *   `quarantined`, with `next`'s reasons;
   * - an id it holds that `next` schedules: `inactive` when the store had it
   *   `disabled`, or quarantined by a resolution reason; otherwise its state
   *   and reasons are kept (the supervisor's: `active`, or a `process_failed`
   *   quarantine of a bundle the publish did not change).
   *
   * An id `next` does not hold leaves `snapshot().bundles`. The issues become
   * `next.issues`; errors, reports and the recovery mode are kept. Entries
   * without a manifest are listed as `load` lists them. Never throws; calling
   * it twice with the same `next` changes nothing the second time.
   */
  adopt(next: ResolvedEnvironment): void {
    const held = new Map(this.#bundles);
    const records: BundleRecord[] = [];

    this.#bundles.clear();

    for (const entry of next.entries) {
      if (entry.manifest === undefined) {
        records.push(recordOf(entry));
        continue;
      }

      if (this.#bundles.has(entry.id)) {
        continue;
      }

      const previous = held.get(entry.id);
      let record: BundleRecord;

      if (previous === undefined) {
        record = recordOf(entry);
        this.#indexRequires(next, entry);
      } else if (entry.state !== 'scheduled') {
        record = recordOf(entry);
      } else if (
        previous.state === 'disabled' ||
        (previous.state === 'quarantined' &&
          previous.resolutionQuarantine === true)
      ) {
        record = recordOf(entry);
      } else {
        record = previous;
        record.version = entry.version;

        if (entry.phase !== undefined) {
          record.phase = entry.phase;
        }
      }

      records.push(record);
      this.#bundles.set(entry.id, record);
    }

    this.#records.splice(0, this.#records.length, ...records);
    this.#issues.splice(0, this.#issues.length, ...next.issues);
  }

  get mode(): 'normal' | 'recovery' {
    return this.#recovery === undefined ? 'normal' : 'recovery';
  }

  enterRecovery(reason: string): void {
    this.#recovery ??= { reason };
  }

  state(id: string): BundleState | undefined {
    return this.#bundles.get(id)?.state;
  }

  setState(id: string, state: BundleState, activationMs?: number): void {
    const record = this.#bundles.get(id);

    if (record !== undefined) {
      record.state = state;

      if (activationMs !== undefined) {
        record.activationMs = activationMs;
      }
    }
  }

  quarantine(id: string, reason: QuarantineReason): void {
    const record = this.#bundles.get(id);

    if (record !== undefined) {
      record.state = 'quarantined';
      record.resolutionQuarantine = false;
      record.reasons.push(reason);
    }
  }

  reasons(id: string): readonly QuarantineReason[] {
    return this.#bundles.get(id)?.reasons ?? [];
  }

  report(entry: DiagnosticReport): void {
    const error: DiagnosticError = {
      at: new Date(this.#now()).toISOString(),
      bundleId: entry.bundleId,
      kind: entry.kind,
      message: entry.message,
      ...(entry.details === undefined ? {} : { details: entry.details }),
    };

    this.#errors.push(error);

    const ofBundle = this.#errors.filter(
      ({ bundleId }) => bundleId === entry.bundleId,
    );

    if (ofBundle.length > DIAGNOSTIC_ERRORS_PER_BUNDLE) {
      const oldest = ofBundle[0] as DiagnosticError;

      this.#errors.splice(this.#errors.indexOf(oldest), 1);
    }
  }

  snapshot(): Diagnostics {
    const bundles: DiagnosticBundle[] = this.#records.map((record) => ({
      id: record.id,
      version: record.version,
      state: record.state,
      ...(record.phase === undefined ? {} : { phase: record.phase }),
      reasons: [...record.reasons],
      ...(record.activationMs === undefined
        ? {}
        : { activationMs: record.activationMs }),
    }));

    return {
      generation: this.#generation,
      mode: this.mode,
      ...(this.#recovery === undefined ? {} : { recovery: this.#recovery }),
      issues: [...this.#issues],
      bundles,
      errors: this.#errors.map((error) => ({ ...error })),
      consumers: Object.fromEntries(
        [...this.#consumers.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([contract, consumers]) => [contract, [...consumers].sort()]),
      ),
    };
  }
}
