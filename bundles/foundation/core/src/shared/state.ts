import {
  type Call,
  ContractError,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  type Services,
} from 'bundle/contracts';

import { createWriteQueue, type WriteQueue } from './writes.js';

/** The platform principal: it passes every ownership check. */
export const PLATFORM = 'doric';

/** What the facades read from `doric.catalog/v1`. */
export interface CatalogLookup {
  /** Contract ID → version of each entry of the bundle's manifest `provides`. */
  provides(bundleId: string): ReadonlyMap<string, string>;
  /** The active host provider of a contract, when there is one. */
  activeProvider(contractId: string): string | undefined;
}

export interface CoreState {
  /** The serializer of `settings.set` and the secrets writes. */
  readonly writes: WriteQueue;
  /** Epoch milliseconds; `Date.now` unless a test fixes the clock. */
  readonly now: () => number;
  /** The catalog of the caller's generation, read once per generation. */
  catalog(call: Call, services: Services): CatalogLookup;
  /** Records a failure in `doric.diagnostics/v1`; never throws. */
  report(
    services: Services,
    bundleId: string,
    kind: string,
    error: unknown,
  ): void;
}

export interface CoreStateOptions {
  readonly now?: () => number;
}

/** `id@version` → [id, version]; the version is what follows the last `@`. */
const splitEntry = (entry: string): readonly [string, string] => {
  const at = entry.lastIndexOf('@');

  return at <= 0 ? [entry, ''] : [entry.slice(0, at), entry.slice(at + 1)];
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The core's shared state. Creating it does no I/O: the catalog is read on
 * the first call that needs it.
 */
export const createCoreState = (options: CoreStateOptions = {}): CoreState => {
  const lookups = new Map<number, CatalogLookup>();

  return {
    writes: createWriteQueue(),
    now: options.now ?? Date.now,
    catalog: (call, services) => {
      const generation = call.caller.generation;
      const cached = lookups.get(generation);

      if (cached !== undefined) {
        return cached;
      }

      const snapshot = services.use(DoricCatalogV1).get(call);
      const provides = new Map<string, ReadonlyMap<string, string>>(
        snapshot.bundles.map((bundle) => [
          bundle.id,
          new Map((bundle.manifest?.provides ?? []).map(splitEntry)),
        ]),
      );
      const active = new Map<string, string>();

      for (const contract of snapshot.contracts) {
        const provider = contract.providers[0];

        if (contract.environment === 'host' && provider !== undefined) {
          active.set(contract.id, provider.bundleId);
        }
      }

      const lookup: CatalogLookup = {
        provides: (bundleId) => provides.get(bundleId) ?? new Map(),
        activeProvider: (contractId) => active.get(contractId),
      };

      lookups.set(generation, lookup);

      return lookup;
    },
    report: (services, bundleId, kind, error) => {
      try {
        services.use(DoricDiagnosticsV1).report({
          bundleId,
          kind,
          message: messageOf(error),
        });
      } catch {
        // Diagnostics are best effort.
      }
    },
  };
};

/** The namespace of a contract ID: its first segment (`git.status/v1` → `git`). */
export const namespaceOf = (id: string): string => {
  const end = id.search(/[./]/);

  return end < 0 ? id : id.slice(0, end);
};

/**
 * The definition rule shared by `storage/v1.defineType`, `settings/v1.register`
 * and `events/v1.register`: the ID's namespace is the caller, and the caller
 * lists the ID in `provides`. Returns the declared version (the caller's own
 * version for the platform).
 */
export const assertDefinitionOwner = (
  state: CoreState,
  call: Call,
  services: Services,
  id: string,
  what: string,
): string => {
  const caller = call.caller.bundleId;

  if (caller === PLATFORM) {
    return call.caller.version;
  }

  if (namespaceOf(id) !== caller) {
    throw new ContractError(
      'not_owner',
      `Bundle "${caller}" cannot define the ${what} ${id}: its namespace belongs to "${namespaceOf(id)}".`,
      { contract: id, bundleId: caller },
    );
  }

  const version = state.catalog(call, services).provides(caller).get(id);

  if (version === undefined) {
    throw new ContractError(
      'undeclared_provide',
      `Bundle "${caller}" defines the ${what} ${id} without declaring it in provides.`,
      { contract: id, bundleId: caller },
    );
  }

  return version;
};

/** A registration handle whose `dispose` runs once. */
export const once = (dispose: () => void) => {
  let done = false;

  return {
    dispose: () => {
      if (!done) {
        done = true;
        dispose();
      }
    },
  };
};
