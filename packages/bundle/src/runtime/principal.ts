import type { Caller } from '../contracts/call.js';
import type { ProviderInfo, Services } from '../contracts/context.js';
import type { Cardinality } from '../contracts/define.js';
import type { Environment } from '../contracts/ids.js';
import type { DiagnosticReport } from '../contracts/platform.js';
import type { ClientPart } from '../sdk/client/client.js';
import type { Directory } from './directory.js';
import { DisposalScope } from './scope.js';

/** What the services runtime needs to know about the resolved catalog. */
export interface ContractCatalogView {
  /** Cardinality published for a contract in this environment, when known. */
  cardinality(contractId: string): Cardinality | undefined;
  /** For a `one` contract: the bundle the catalog made its active provider here. */
  activeProvider(contractId: string): string | undefined;
}

export const emptyCatalogView: ContractCatalogView = Object.freeze({
  cardinality: () => undefined,
  activeProvider: () => undefined,
});

/**
 * A window's way to the host's contracts over Connect (phase 3): the client
 * part of each bundle over the window's transport, and the host providers of
 * its pinned generation.
 */
export interface HostClients {
  /**
   * The client part whose calls carry `doric-client-part: <bundleId>`; one
   * per bundle id, created on first use. Creating it makes no call.
   */
  part(bundleId: string): ClientPart;
  /**
   * The provider the window's pinned generation lists for a host contract
   * id (`(doric.platform.v1.contract).id`), or undefined when it lists none.
   */
  provider(contractId: string): ProviderInfo | undefined;
}

/** Shared state of one environment of one generation. */
export interface ServiceRuntime {
  readonly directory: Directory;
  readonly catalog: ContractCatalogView;
  readonly environment: Environment;
  readonly generation: number;
  /**
   * Generation calls without a parent are pinned to: 0 in the kernel and in
   * single-process hosts, N in the process of generation N.
   */
  readonly operationGeneration?: number;
  /** Aborted when the generation ends; the default `call.signal`. */
  readonly generationSignal: AbortSignal;
  /** Records a failure against a bundle in diagnostics. */
  readonly report: (entry: DiagnosticReport) => void;
  readonly now?: () => number;
  /**
   * The kernel's respawn window (G-11): a promise that settles once a provider
   * of `contractId` may be active again, or undefined when there is nothing
   * to wait for and the call answers `unavailable` now.
   */
  readonly awaitProvider?: (
    contractId: string,
    signal: AbortSignal | undefined,
  ) => Promise<void> | undefined;
  /**
   * A window's Connect clients of host contracts: `services.use` and
   * `whenAvailable` of a generated service descriptor answer through it
   * (`ClientServices`). Absent (the kernel, desktopMain, host processes):
   * `use` of a descriptor throws `ContractError('unavailable')` and
   * `whenAvailable` of one never calls back.
   */
  readonly hostClients?: HostClients;
}

export interface DeclaredProvide {
  readonly version: string;
  readonly cardinality: Cardinality;
}

export interface PrincipalOptions {
  readonly bundleId: string;
  readonly version: string;
  /** Contracts this bundle provides in this environment; `any` disables the check. */
  readonly provides: ReadonlyMap<string, DeclaredProvide> | 'any';
  /** Every contract ID in the manifest `provides` (all environments). */
  readonly ownContracts?: ReadonlySet<string>;
  /** Manifest `requires`; `any` disables the check. */
  readonly requires: ReadonlySet<string> | 'any';
  /** The composition's core may use basic contracts without `requires`. */
  readonly isCore?: boolean;
}

/** One bundle (or the platform) in one environment of one generation. */
export class Principal {
  readonly runtime: ServiceRuntime;
  readonly options: PrincipalOptions;
  readonly caller: Caller;
  /** Activation scope: everything this principal registers by default. */
  readonly scope: DisposalScope;
  /** Cached hooks handles, by hooks contract ID (one handle per owner). */
  readonly hookHandles = new Map<string, unknown>();
  #current: DisposalScope;
  #closed = false;
  /** Errors a registration through services raised (provide or a register call). */
  readonly #registrationErrors = new WeakSet<object>();
  services!: Services;
  /** Same principal, without the `requires` check (loader-internal paths). */
  unchecked!: Services;

  constructor(runtime: ServiceRuntime, options: PrincipalOptions) {
    this.runtime = runtime;
    this.options = options;
    this.caller = Object.freeze({
      bundleId: options.bundleId,
      version: options.version,
      generation: runtime.generation,
    });
    this.scope = new DisposalScope((error) =>
      runtime.report({
        bundleId: options.bundleId,
        kind: 'dispose_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    this.#current = this.scope;
  }

  get bundleId(): string {
    return this.options.bundleId;
  }

  /** The scope stub results are tracked in right now. */
  get current(): DisposalScope {
    return this.#current;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Runs `fn` synchronously with `scope` as the current disposal scope. */
  runInScope<T>(scope: DisposalScope, fn: () => T): T {
    const previous = this.#current;

    this.#current = scope;

    try {
      return fn();
    } finally {
      this.#current = previous;
    }
  }

  /** Marks an error thrown by a registration this principal made. */
  noteRegistrationError(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      this.#registrationErrors.add(error);
    }
  }

  /** Whether `error` came from a registration this principal made. */
  isRegistrationError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      this.#registrationErrors.has(error)
    );
  }

  /** After close, every stub of this principal refuses calls. */
  close(): void {
    this.#closed = true;
  }
}
