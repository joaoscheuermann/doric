import type { MethodSpec } from '../contracts/basic/common.js';
import type { Call } from '../contracts/call.js';
import type { Cardinality } from '../contracts/define.js';
import { ContractError } from '../contracts/error.js';
import type { Environment } from '../contracts/ids.js';

/**
 * One active provider of a contract. `invoke` runs a method with an already
 * validated input; in-process records call the definition directly, and later
 * stages add envelope- or bridge-backed records behind the same seam.
 */
export interface ProviderRecord {
  readonly contractId: string;
  readonly bundleId: string;
  /** Version of the providing bundle. */
  readonly version: string;
  /** Version of the contract, as declared in `provides`. */
  readonly contractVersion: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  readonly methods: Readonly<Record<string, MethodSpec>>;
  /** Where the provider runs: in this process (default) or across the envelope. */
  readonly origin?: 'local' | 'remote';
  invoke(method: string, input: unknown, call: Call): unknown;
}

export interface ProviderListener {
  added(record: ProviderRecord): void;
  removed(record: ProviderRecord): void;
}

/** Active providers per contract ID, with synchronous availability notifications. */
export interface Directory {
  /** Registers a provider; returns its unregister function. */
  register(record: ProviderRecord): () => void;
  providers(contractId: string): readonly ProviderRecord[];
  /** The active provider of a `one` contract (the first one for `many`). */
  active(contractId: string): ProviderRecord | undefined;
  isActive(record: ProviderRecord): boolean;
  /** Subscribes to a contract; `added` runs now for every active provider. */
  subscribe(contractId: string, listener: ProviderListener): () => void;
}

/** The plain in-memory directory of one process. */
export class ServiceDirectory implements Directory {
  readonly #providers = new Map<string, ProviderRecord[]>();
  readonly #listeners = new Map<string, Set<ProviderListener>>();

  /** Registers a provider; returns its unregister function. */
  register(record: ProviderRecord): () => void {
    const current = this.#providers.get(record.contractId) ?? [];

    if (record.cardinality === 'one' && current.length > 0) {
      const active = current[0] as ProviderRecord;

      throw new ContractError(
        'provider_conflict',
        `Contract "${record.contractId}" already has an active provider: bundle "${active.bundleId}".`,
      );
    }

    this.#providers.set(record.contractId, [...current, record]);

    for (const listener of [
      ...(this.#listeners.get(record.contractId) ?? []),
    ]) {
      listener.added(record);
    }

    let registered = true;

    return () => {
      if (!registered) {
        return;
      }

      registered = false;

      const remaining = (this.#providers.get(record.contractId) ?? []).filter(
        (entry) => entry !== record,
      );

      if (remaining.length === 0) {
        this.#providers.delete(record.contractId);
      } else {
        this.#providers.set(record.contractId, remaining);
      }

      for (const listener of [
        ...(this.#listeners.get(record.contractId) ?? []),
      ]) {
        listener.removed(record);
      }
    };
  }

  providers(contractId: string): readonly ProviderRecord[] {
    return this.#providers.get(contractId) ?? [];
  }

  /** The active provider of a `one` contract (the first one for `many`). */
  active(contractId: string): ProviderRecord | undefined {
    return this.#providers.get(contractId)?.[0];
  }

  isActive(record: ProviderRecord): boolean {
    return this.#providers.get(record.contractId)?.includes(record) ?? false;
  }

  /** Subscribes to a contract; `added` runs now for every active provider. */
  subscribe(contractId: string, listener: ProviderListener): () => void {
    const listeners = this.#listeners.get(contractId) ?? new Set();

    listeners.add(listener);
    this.#listeners.set(contractId, listeners);

    for (const record of this.providers(contractId)) {
      if (listeners.has(listener)) {
        listener.added(record);
      }
    }

    return () => {
      listeners.delete(listener);
    };
  }
}
