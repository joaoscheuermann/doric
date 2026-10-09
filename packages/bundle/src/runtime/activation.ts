import type { HookHandle } from '../contracts/basic/hooks.js';
import { HooksV1 } from '../contracts/basic/hooks.js';
import type { Activate, Cleanup } from '../contracts/context.js';
import { isContractError } from '../contracts/error.js';
import { AppHooksV1, type QuarantineCode } from '../contracts/platform.js';
import type { CatalogEntry, ResolvedEnvironment } from './catalog.js';
import type { DiagnosticsStore } from './diagnostics.js';
import { isRegistrationConflict } from './dispatch.js';
import { parseContractEntry } from './manifest.js';
import type {
  ContractCatalogView,
  DeclaredProvide,
  Principal,
  PrincipalOptions,
  ServiceRuntime,
} from './principal.js';
import { createPrincipal } from './services.js';

/** The platform's own log, independent of any log/v1 provider. */
export interface PlatformLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** A failure with the quarantine code the loader should record. */
export class ActivationFailure extends Error {
  override readonly name = 'ActivationFailure';
  readonly code: QuarantineCode;

  constructor(code: QuarantineCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const codeOf = (error: unknown, fallback: QuarantineCode): QuarantineCode =>
  error instanceof ActivationFailure ||
  (typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ActivationFailure')
    ? (error as ActivationFailure).code
    : fallback;

/**
 * The quarantine code of an error thrown by `activate`: a registration the
 * bundle made through services that was refused keeps its own reason; any
 * other error comes from the bundle's own code.
 */
const activateFailureCode = (
  principal: Principal,
  error: unknown,
): QuarantineCode => {
  if (!principal.isRegistrationError(error)) {
    return 'activate_failed';
  }

  return isContractError(error) && error.code === 'cardinality_mismatch'
    ? 'cardinality_mismatch'
    : 'registration_failed';
};

/** The catalog view the services runtime uses, from one resolved environment. */
export const catalogView = (
  resolved: ResolvedEnvironment,
): ContractCatalogView => {
  const contracts = new Map(
    resolved.contracts.map((contract) => [contract.id, contract]),
  );

  return Object.freeze({
    cardinality: (id: string) => contracts.get(id)?.cardinality,
    activeProvider: (id: string) => {
      const contract = contracts.get(id);

      return contract?.cardinality === 'one'
        ? contract.providers[0]?.bundleId
        : undefined;
    },
  });
};

/** Principal options of a catalog entry in one environment. */
export const principalOptionsFor = (
  entry: CatalogEntry,
  resolved: ResolvedEnvironment,
): PrincipalOptions => {
  const provides = new Map<string, DeclaredProvide>();

  for (const contract of entry.descriptor?.contracts ?? []) {
    if (contract.environment === resolved.environment) {
      provides.set(contract.id, {
        version: contract.version,
        cardinality: contract.cardinality,
      });
    }
  }

  const ids = (entries: readonly string[] | undefined) =>
    new Set(
      (entries ?? []).flatMap((declared) => {
        const parsed = parseContractEntry(declared);

        return parsed === undefined ? [] : [parsed.id];
      }),
    );

  return {
    bundleId: entry.id,
    version: entry.version,
    provides,
    ownContracts: ids(entry.manifest?.provides),
    requires: ids(entry.manifest?.requires),
    isCore: entry.id === resolved.composition.core,
  };
};

export interface ActivationOptions {
  readonly resolved: ResolvedEnvironment;
  readonly runtime: ServiceRuntime;
  /** Principal `doric`; it defines AppHooksV1 and fires the lifecycle hooks. */
  readonly platform: Principal;
  readonly diagnostics: DiagnosticsStore;
  /** Loads the part of this environment; undefined when the bundle has none. */
  readonly loadPart: (entry: CatalogEntry) => Promise<Activate | undefined>;
  /** Runs after a successful `activate` (skills registration on the host). */
  readonly afterActivate?: (
    entry: CatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  /** Extra platform definitions once the hooks/v1 provider is active. */
  readonly onHooksProviderReady?: (platform: Principal) => void | Promise<void>;
  /**
   * Bundles already active elsewhere in this environment (another process);
   * they satisfy the dependency check. Default: none.
   */
  readonly preActive?: readonly string[];
  /**
   * `remote`: hooks/v1 is provided outside this loop, so AppHooksV1 is
   * defined before the first bundle and every bundle is observed. Default
   * `local`: AppHooksV1 is defined once the hooks/v1 provider activates.
   */
  readonly hooksProvider?: 'local' | 'remote';
  /**
   * Waits for the bundle's pending registrations; runs after `activate` and
   * again after `afterActivate`. A rejection quarantines the bundle with the
   * code the same refusal raised in-process would have produced.
   */
  readonly settle?: (
    entry: CatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  /**
   * Runs once a bundle's principal exists, before its part loads (the
   * envelope needs it to scope callbacks the bundle exports).
   */
  readonly onPrincipal?: (entry: CatalogEntry, principal: Principal) => void;
  readonly log?: PlatformLog;
  readonly now?: () => number;
}

interface ActiveBundle {
  readonly entry: CatalogEntry;
  readonly principal: Principal;
  readonly cleanup?: Cleanup;
  /** Activated after AppHooksV1 was defined, so its deactivation is observable. */
  readonly observed: boolean;
}

export interface ActivationResult {
  readonly mode: 'normal' | 'recovery';
  /** Active bundles, in activation order. */
  readonly active: readonly string[];
  readonly principals: ReadonlyMap<string, Principal>;
  /** The AppHooksV1 handle, once the hooks/v1 provider activated. */
  readonly appHooks: () => HookHandle<typeof AppHooksV1> | undefined;
  /** Reverse deactivation; idempotent. */
  stop(): Promise<void>;
}

const environmentOf = (resolved: ResolvedEnvironment) => resolved.environment;

/**
 * The generic activation loop of one environment: foundation, core, others,
 * each with its own services and disposal scope; quarantine on failure,
 * recovery when core or a chosen foundation provider fails.
 */
export const activateEnvironment = async (
  options: ActivationOptions,
): Promise<ActivationResult> => {
  const { resolved, runtime, platform, diagnostics, log } = options;
  const now = options.now ?? Date.now;
  // Only scheduled entries activate; there is at most one per ID.
  const entries = new Map(
    resolved.entries
      .filter(({ state }) => state === 'scheduled')
      .map((entry) => [entry.id, entry]),
  );
  const hooksProvider =
    options.hooksProvider === 'remote'
      ? undefined
      : resolved.contracts.find(({ id }) => id === 'hooks/v1')?.providers[0]
          ?.bundleId;
  const active: ActiveBundle[] = [];
  const activeIds = new Set<string>(options.preActive ?? []);
  const principals = new Map<string, Principal>();
  let appHooks: HookHandle<typeof AppHooksV1> | undefined;
  const lifecycle = (entry: CatalogEntry) => ({
    bundleId: entry.id,
    version: entry.version,
    generation: runtime.generation,
    environment: environmentOf(resolved),
  });
  const reportPlatform = (kind: string, error: unknown, details?: unknown) =>
    diagnostics.report({
      bundleId: platform.bundleId,
      kind,
      message: messageOf(error),
      ...(details === undefined ? {} : { details }),
    });
  if (options.hooksProvider === 'remote') {
    try {
      appHooks = platform.services.use(HooksV1).define(AppHooksV1);
    } catch (error) {
      reportPlatform('app_hooks_failed', error);
    }
  }

  const settleFailureCode = (
    principal: Principal,
    error: unknown,
  ): QuarantineCode => {
    if (isRegistrationConflict(error)) {
      principal.noteRegistrationError(error);
    }

    return activateFailureCode(principal, error);
  };
  const fail = (entry: CatalogEntry, code: QuarantineCode, message: string) => {
    diagnostics.quarantine(entry.id, { code, message });
    log?.warn(
      { bundleId: entry.id, reasons: diagnostics.reasons(entry.id) },
      'Bundle quarantined',
    );

    if (entry.id === resolved.composition.core) {
      diagnostics.enterRecovery(`core ${entry.id} failed: ${message}`);
    } else if (entry.phase === 'foundation') {
      diagnostics.enterRecovery(
        `chosen foundation provider ${entry.id} failed: ${message}`,
      );
    }
  };

  for (const id of resolved.order) {
    const entry = entries.get(id);

    if (entry === undefined) {
      continue;
    }

    if (diagnostics.mode === 'recovery') {
      diagnostics.setState(id, 'inactive');
      continue;
    }

    const missing = entry.dependencies.filter(
      (dependency) => !activeIds.has(dependency),
    );

    if (missing.length > 0) {
      fail(
        entry,
        'dependency_quarantined',
        `depends on a bundle that is not active: ${missing.join(', ')}`,
      );
      continue;
    }

    const started = now();
    const principal = createPrincipal(
      runtime,
      principalOptionsFor(entry, resolved),
    );
    let cleanup: Cleanup | undefined;

    options.onPrincipal?.(entry, principal);

    try {
      let part: Activate | undefined;

      try {
        part = await options.loadPart(entry);
      } catch (error) {
        throw new ActivationFailure(
          codeOf(error, 'invalid_part'),
          messageOf(error),
          {
            cause: error,
          },
        );
      }

      if (part !== undefined) {
        try {
          const result = await part({ services: principal.services });

          if (typeof result === 'function') {
            cleanup = result;
          }
        } catch (error) {
          throw new ActivationFailure(
            activateFailureCode(principal, error),
            messageOf(error),
            { cause: error },
          );
        }
      }

      if (options.settle !== undefined) {
        try {
          await options.settle(entry, principal);
        } catch (error) {
          throw new ActivationFailure(
            settleFailureCode(principal, error),
            messageOf(error),
            { cause: error },
          );
        }
      }

      if (options.afterActivate !== undefined) {
        try {
          await options.afterActivate(entry, principal);
          await options.settle?.(entry, principal);
        } catch (error) {
          throw new ActivationFailure(
            codeOf(error, 'registration_failed'),
            messageOf(error),
            { cause: error },
          );
        }
      }
    } catch (error) {
      // Undo the reversible registrations of this attempt.
      await principal.scope.dispose();

      if (cleanup !== undefined) {
        try {
          await cleanup();
        } catch (cleanupError) {
          reportPlatform('cleanup_failed', cleanupError, { bundleId: id });
        }
      }

      principal.close();
      fail(entry, codeOf(error, 'activate_failed'), messageOf(error));
      continue;
    }

    active.push({
      entry,
      principal,
      ...(cleanup === undefined ? {} : { cleanup }),
      observed: appHooks !== undefined,
    });
    activeIds.add(id);
    principals.set(id, principal);
    diagnostics.setState(id, 'active', now() - started);

    if (id === hooksProvider) {
      try {
        appHooks = platform.services.use(HooksV1).define(AppHooksV1);
        await options.onHooksProviderReady?.(platform);
      } catch (error) {
        reportPlatform('app_hooks_failed', error);
      }
    } else if (appHooks !== undefined) {
      try {
        await appHooks.onActivateHook.execute(lifecycle(entry));
      } catch (error) {
        reportPlatform('hook_execute_failed', error, {
          hook: 'onActivateHook',
          bundleId: id,
        });
      }
    }
  }

  let stopping: Promise<void> | undefined;

  return {
    mode: diagnostics.mode,
    active: active.map(({ entry }) => entry.id),
    principals,
    appHooks: () => appHooks,
    stop: () => {
      stopping ??= (async () => {
        for (const bundle of [...active].reverse()) {
          if (bundle.observed && appHooks !== undefined) {
            try {
              await appHooks.onDeactivateHook.execute(lifecycle(bundle.entry));
            } catch (error) {
              reportPlatform('hook_execute_failed', error, {
                hook: 'onDeactivateHook',
                bundleId: bundle.entry.id,
              });
            }
          }

          await bundle.principal.scope.dispose();

          if (bundle.cleanup !== undefined) {
            try {
              await bundle.cleanup();
            } catch (error) {
              reportPlatform('cleanup_failed', error, {
                bundleId: bundle.entry.id,
              });
            }
          }

          bundle.principal.close();
          diagnostics.setState(bundle.entry.id, 'inactive');
        }
      })();

      return stopping;
    },
  };
};
