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
import { parseContractEntry } from './manifest.js';

/** Recent errors kept per bundle. */
export const DIAGNOSTIC_ERRORS_PER_BUNDLE = 50;

interface BundleRecord {
  readonly id: string;
  readonly version: string;
  state: BundleState;
  phase?: Phase;
  readonly reasons: QuarantineReason[];
  activationMs?: number;
}

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
      const record: BundleRecord = {
        id: entry.id,
        version: entry.version,
        state:
          entry.state === 'scheduled'
            ? 'inactive'
            : entry.state === 'disabled'
              ? 'disabled'
              : 'quarantined',
        ...(entry.phase === undefined ? {} : { phase: entry.phase }),
        reasons: [...entry.reasons],
      };

      this.#records.push(record);

      if (entry.manifest === undefined || this.#bundles.has(entry.id)) {
        // A duplicate ID, or a bundle without a readable manifest (no known
        // ID, D-35), stays visible but never receives later states.
        continue;
      }

      this.#bundles.set(entry.id, record);

      if (entry.state !== 'disabled') {
        for (const required of entry.manifest?.requires ?? []) {
          const parsed = parseContractEntry(required);

          if (parsed !== undefined) {
            const consumers = this.#consumers.get(parsed.id) ?? new Set();

            consumers.add(entry.id);
            this.#consumers.set(parsed.id, consumers);
          }
        }
      }
    }

    if (resolved.recovery !== undefined) {
      this.enterRecovery(resolved.recovery.reason);
    }
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
