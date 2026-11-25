// The platform of a host (spec `docs/designs/grpc-processes.md`, sections 1,
// 6, 7 and 11): the router listener, the supervisor of the bundle processes
// and the gateway. Exported from the package as `bundle/platform` (phase 3);
// Node only, not reachable from a window.

import {
  create,
  createFileRegistry,
  type DescService,
} from '@bufbuild/protobuf';
import { anyPack } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError, createClient } from '@connectrpc/connect';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import { createTransport } from '@connectrpc/connect/protocol-grpc';

import {
  StorageBackendV1,
  type StorageIdentity,
} from '../contracts/basic/storage.js';
import { ContractError } from '../contracts/error.js';
import { HooksService } from '../contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  file_doric_platform_app_hooks_v1_hooks,
  OnHostReadyHookInputSchema,
  OnHostStartHookInputSchema,
  OnHostStopHookInputSchema,
} from '../contracts/gen/doric/platform/app/hooks/v1/hooks_pb.js';
import { file_doric_platform_bundle_v1_bundle } from '../contracts/gen/doric/platform/bundle/v1/bundle_pb.js';
import { file_doric_platform_diagnostics_v1_diagnostics } from '../contracts/gen/doric/platform/diagnostics/v1/diagnostics_pb.js';
import { file_doric_platform_generation_v1_generation } from '../contracts/gen/doric/platform/generation/v1/generation_pb.js';
import { file_doric_platform_log_v1_log } from '../contracts/gen/doric/platform/log/v1/log_pb.js';
import { file_doric_platform_startup_v1_startup } from '../contracts/gen/doric/platform/startup/v1/startup_pb.js';
import { BackendService } from '../contracts/gen/doric/storage/backend/v1/backend_pb.js';
import type { QuarantineReason } from '../contracts/platform.js';
import { fromConnectError } from '../contracts/status.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import type {
  DiagnosticsStore,
  HostStalledReport,
  RegistrationReplayReport,
} from '../runtime/diagnostics.js';
import { type CatalogIndex, createCatalogIndex } from './catalog-index.js';
import { type Gateway, startGateway } from './gateway/index.js';
import { maxMessageBytes } from './router/control.js';
import { InstanceTable } from './router/instances.js';
import { type Router, startRouter } from './router/listener.js';
import {
  createBundleService,
  createCatalogService,
  createDiagnosticsService,
  createGenerationService,
  createLogService,
  createStartupService,
  type LogServiceOptions,
  type StartupSink,
} from './router/platform-services.js';
import { callRoutesOf } from './router/route.js';
import {
  type PublishResult,
  type PublishTarget,
  publish,
} from './supervisor/publish.js';
import { createRouterRelay } from './supervisor/router-relay.js';
import type { SpawnCommand } from './supervisor/spawn.js';
import { startSupervisor } from './supervisor/supervisor.js';
import {
  timings as platformTimings,
  type Timings,
} from './supervisor/timings.js';

export {
  basicHostContractFiles,
  withBasicContracts,
} from './basic-contracts.js';
export {
  type CatalogIndex,
  catalogIndexFromDescriptors,
  createCatalogIndex,
} from './catalog-index.js';
export {
  defaultPublicAddress,
  PublicListenerBindingError,
} from './gateway/index.js';
export type { StartupSink } from './router/platform-services.js';
export {
  readStagedCatalogIndex,
  stagedCommandOf,
  stagedHostPart,
} from './staged.js';
export type { PublishResult } from './supervisor/publish.js';
export type { SpawnCommand } from './supervisor/spawn.js';

/**
 * The platform's own caller, `doric` (generation 0, incarnation 0: the
 * gateway's caller, `route.ts`'s `gatewayCaller`), which has no instance and
 * no client part.
 */
export interface DoricCaller {
  /**
   * A Connect client of `service` whose every call the router serves in
   * process as a call of `doric`: steps 2 to 4 of section 3 as for a bundle's
   * call, step 3 letting every method of a contract service through (no lists
   * to check); a method of a handler service answers `not_owner`. `service`
   * must be in `PlatformOptions.index` or be a platform contract the router
   * serves, else the call fails `UNIMPLEMENTED`. A call without `timeoutMs`
   * waits at most `timings.activeWaitMs` for an active provider, then fails
   * `unavailable`; `signal` cancels it. Failures are `ConnectError`s carrying
   * the Doric code (`fromConnectError` reads it). Creating the client makes no
   * call and never throws; once `shutdown` closed the router, every call fails
   * `unavailable`.
   */
  client<S extends DescService>(service: S): Client<S>;
}

export interface PlatformOptions {
  /** `DORIC_ROUTER_ADDRESS`; `defaultRouterAddress` when undefined. */
  readonly routerAddress?: string;
  /**
   * The public listener's address, `<host>:<port>` (`DORIC_HOST` and
   * `DORIC_PORT`; the host passes `defaultPublicAddress` when they are
   * unset); port 0 binds a free port. Undefined: no gateway and no public
   * listener, and {@link Platform.publicPort} is undefined.
   */
  readonly publicAddress?: string;
  /**
   * The methods the router serves (`createCatalogIndex`). The methods of
   * the platform contracts served in process (`doric.generation/v1`,
   * `doric.log/v1`, `doric.catalog/v1`, `doric.diagnostics/v1`,
   * `doric.bundle/v1`) are served whether or not it holds them. The gateway
   * serves the public API and the `DESKTOP` methods of it that a resolution
   * provides (`servedMethods`), and transcodes their JSON with its
   * descriptors.
   */
  readonly index: CatalogIndex;
  /** The host environment's resolution, booted by `startPlatform`. */
  readonly resolved: ResolvedEnvironment;
  /** The command of a bundle (A64); see `SupervisorOptions.commandOf`. */
  readonly commandOf: (bundleId: string) => SpawnCommand;
  /**
   * The SHA-256 of a bundle's executable as it is now, which a publish
   * compares (section 6, "Publish"); see `SupervisorOptions.digestOf`.
   * Every digest is `''` when undefined. Must not throw.
   */
  readonly digestOf?: (bundleId: string) => string;
  /** The base of every instance's environment; `process.env` when undefined. */
  readonly env?: NodeJS.ProcessEnv;
  /** The platform's `timings` when undefined; tests pass shorter ones. */
  readonly timings?: Timings;
  /**
   * Where the router and the supervisor record states, quarantines and the
   * reports of section 15; the router's `hostStalled` becomes a
   * `host_stalled` report of the instance's bundle.
   */
  readonly diagnostics: DiagnosticsStore;
  /**
   * The host's structural providers (section 7, "Structural providers"):
   * bundles, and contracts whose provider, that the host cannot run without.
   * Empty when undefined.
   */
  readonly required?: {
    readonly bundles: readonly string[];
    readonly contracts: readonly string[];
  };
  /**
   * Ends the host; `process.exit` when undefined. Called once, with 1, when a
   * required bundle (see {@link PlatformOptions.required}) is quarantined after the boot,
   * after the log `Bundle recovery mode` with the bundle and the reason;
   * `shutdown` is not run first. Not called by `shutdown`.
   */
  readonly exit?: (code: number) => void;
  /**
   * Called for every quarantine the supervisor decides, after the
   * diagnostics hold it. Must not throw.
   */
  readonly onQuarantine?: (bundleId: string, reason: QuarantineReason) => void;
  /**
   * Where the records of `doric.log/v1.Write`, which the platform serves in
   * process with `doric.generation/v1` (A65), go: one JSON line per record on
   * stdout when undefined. Must not throw.
   */
  readonly writeLog?: LogServiceOptions['write'];
  /**
   * The sink of `doric.startup/v1` (`createStartupService`), which the router
   * now always serves. Also told `stage('database_client')` just before the
   * storage identity read. A sink that discards everything when undefined.
   */
  readonly startup?: StartupSink;
  /**
   * Whether a scheduled bundle has a host part (`stagedHostPart` for a staged
   * tree). A bundle for which it answers `false` is never spawned, at the boot
   * or by a publish; it is recorded `active` in the diagnostics with no
   * activation time, counts as active for its dependents, and is never
   * stopped. Read once per bundle per adopted resolution; must not throw.
   * Undefined: every scheduled bundle has one (today's behaviour).
   */
  readonly hostPart?: (bundleId: string) => boolean;
  /**
   * Runs once, after the boot settled and the storage identity was read (when
   * there is a provider), and before the public listener binds: the host's
   * `Bundles loaded` and `onHostStartHook`. Not run when the boot ends with a
   * `structuralFault`. Its rejection makes `startPlatform` shut down what
   * started (no `beforeStop`) and reject with that same value. A required
   * bundle quarantined while it runs still calls `exit(1)`, as after the boot.
   */
  readonly beforeListen?: (doric: DoricCaller) => Promise<void>;
  /**
   * Runs once in `shutdown`, after the public listener closed and before any
   * instance gets `Stop`: the host's `onHostStopHook`. `signal` aborts at the
   * shutdown deadline (`timings.shutdownDeadlineMs` after `shutdown` began);
   * the level stops get what is left of that deadline. A rejection or throw is
   * ignored: `shutdown` goes on and never rejects. Not run for a
   * `startPlatform` that rejected, nor when `structuralFault` is set.
   */
  readonly beforeStop?: (
    doric: DoricCaller,
    signal: AbortSignal,
  ) => Promise<void>;
}

/** A booted platform. Its `client` is the `doric` caller of {@link DoricCaller}. */
export interface Platform extends DoricCaller {
  /**
   * Set when, once the boot settled, a bundle of `required.bundles` is not
   * `active`, or a contract of `required.contracts` has no `active` provider:
   * `structural providers unavailable: <ids, contracts first, then bundles,
   * comma-separated>` (the host's `structuralFault` wording). Then the
   * identity was not read, `beforeListen` did not run, no public listener was
   * bound (`publicPort` undefined), and the host is expected to log `Bundle
   * recovery mode` and call `shutdown`. Undefined otherwise; never changes
   * after `startPlatform` resolved.
   */
  readonly structuralFault?: string;
  /** The router's bound port, the one in every `DORIC_ROUTER_URL`. */
  readonly routerPort: number;
  /**
   * The public listener's bound port, where the gateway serves gRPC and the
   * Connect protocol over HTTP/2 and HTTP/1.1 and the HTTP prefixes
   * (section 11); undefined when {@link PlatformOptions.publicAddress} is.
   */
  readonly publicPort?: number;
  /**
   * Moves the host to the next resolution (section 6, "Publish"): the
   * `publish` of `publish.ts` on the supervisor, with
   * {@link PlatformOptions.digestOf}. Answers `kernel_restart_required` and
   * changes nothing when `core` changed; otherwise moves each changed bundle
   * to a new generation in activation order, drains each replaced or
   * removed generation, and answers `published`, or `failed` with the
   * bundles whose new generation did not become active. Resolves once every
   * changed bundle's new generation is `active` (or failed) and every
   * drained one acknowledged `draining`; the drains finish later. Calls are
   * serialized: a call made while one runs waits for it. Never rejects.
   *
   * The gateway follows the resolution the supervisor adopts
   * (`PublishTarget.adopt`): from then on it serves the methods
   * (`servedMethods`) and the HTTP prefixes of `next`, without a restart, so the methods of a
   * bundle the publish adds are served (a call waits for its active
   * instance, as any call) and those of a bundle it removes answer
   * `UNIMPLEMENTED`; a call or proxied connection already in flight to a
   * draining instance finishes there (T2.16). `kernel_restart_required`
   * leaves the gateway as it was.
   */
  publish(next: ResolvedEnvironment): Promise<PublishResult>;
  /**
   * The host shutdown of section 7: closes the public listener, runs
   * {@link PlatformOptions.beforeStop}, stops every instance by dependency
   * level in reverse activation order within what is left of the shutdown
   * deadline, then closes the router. Never rejects; a second call
   * resolves with the first.
   */
  shutdown(): Promise<void>;
}

/**
 * Binds the router, with the routes of `resolved` (`callRoutesOf`) and the
 * platform services `doric.generation/v1`, `doric.log/v1`,
 * `doric.catalog/v1`, `doric.diagnostics/v1` and `doric.bundle/v1`. Starts
 * the supervisor and boots `resolved` (the supervisor's `boot`). Once the
 * boot has settled, when `resolved` lists a provider of
 * `storage.backend/v1` that is active, reads the host's storage identity
 * once with its `Identity`, under the caller `doric` (as the kernel's
 * `storageIdentity` does); from then on `doric.catalog/v1.Get` answers it
 * in `storage`. Without such a provider nothing is read and `storage` stays
 * absent. Then, with {@link PlatformOptions.publicAddress}, starts the
 * gateway (`startGateway`) on `resolved` and `options.index`, relaying to
 * the router. Resolves once every scheduled bundle is `active` or
 * quarantined, the identity is read (when there is a provider), and the
 * public listener listens. Rejects, after shutting down what started
 * (nothing is left running): with the router's `RouterBindingError` when
 * the router address cannot be bound; with the `ContractError` of the
 * `Identity` call when it fails; with `PublicListenerBindingError` when the
 * public address cannot be bound. A required bundle quarantined during the
 * boot does not reject: the host reads the diagnostics, as today's boot
 * fails at the stage `bundle_load`. A publish never reads the identity
 * again.
 *
 * Also: the router serves `doric.startup/v1` in process
 * (`createStartupService(options.startup ?? silent)`), and its index falls
 * back to that contract's file too; the supervisor spawns only the bundles
 * `options.hostPart` accepts; after the boot settled, when a required
 * provider is missing it resolves with `structuralFault` set and nothing
 * below runs; otherwise, when a provider of `storage.backend/v1` is active,
 * it calls `startup.stage('database_client')` and then reads the identity;
 * then awaits `beforeListen(platform)`; then binds the public listener. It
 * also rejects with `beforeListen`'s rejection, after shutting down what
 * started. A required bundle quarantined during the boot sets
 * `structuralFault` instead of rejecting.
 */
export const startPlatform = async (
  options: PlatformOptions,
): Promise<Platform> => {
  const { diagnostics, resolved } = options;
  const required = options.required ?? { bundles: [], contracts: [] };
  const startup = options.startup ?? silentStartup;
  const shutdownDeadlineMs = (options.timings ?? platformTimings)
    .shutdownDeadlineMs;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const instances = new InstanceTable();
  const relay = createRouterRelay();
  const digestOf = options.digestOf ?? (() => '');
  // The resolution the host runs now, and the storage identity once read.
  let current = resolved;
  let storage: StorageIdentity | undefined;
  const generation = createGenerationService({
    instances,
    signal: (from, topic, payload) =>
      router.sendPeerSignal(from, topic, payload),
  });
  const routerIndex = withPlatformContracts(options.index);
  const router = await startRouter({
    ...(options.routerAddress === undefined
      ? {}
      : { address: options.routerAddress }),
    index: routerIndex,
    routes: callRoutesOf(resolved),
    platformServices: [
      generation,
      createLogService({ write: options.writeLog ?? writeLogLine }),
      createCatalogService({
        resolved: () => current,
        diagnostics,
        storage: () => storage,
        index: () => routerIndex,
      }),
      createDiagnosticsService({ diagnostics }),
      createBundleService(),
      createStartupService(startup),
    ],
    instances,
    ...(options.timings === undefined ? {} : { timings: options.timings }),
    diagnostics: {
      health: () => {},
      hostStalled: (key, delayMs) => {
        const instance = instances.get(key);

        if (instance !== undefined) {
          const report: HostStalledReport = {
            bundleId: instance.bundleId,
            kind: 'host_stalled',
            message: `The host's event loop was blocked for ${delayMs} ms.`,
            details: {
              generation: instance.generation,
              incarnation: instance.incarnation,
              delayMs,
            },
          };

          diagnostics.report(report);
        }
      },
      registrationReplay: (kind, consumerKey, providerKey, message) => {
        const consumer = instances.get(consumerKey);
        const provider = instances.get(providerKey);

        if (consumer !== undefined && provider !== undefined) {
          const report: RegistrationReplayReport = {
            bundleId: consumer.bundleId,
            kind,
            message,
            details: {
              generation: consumer.generation,
              incarnation: consumer.incarnation,
              provider: {
                bundleId: provider.bundleId,
                generation: provider.generation,
                incarnation: provider.incarnation,
              },
            },
          };

          diagnostics.report(report);
        }
      },
    },
    onInvalid: (key, reason, message) => relay.onInvalid(key, reason, message),
    onLost: (key, end) => relay.onLost(key, end),
  });
  const isRequired = (bundleId: string): boolean =>
    required.bundles.includes(bundleId) ||
    resolved.contracts.some(
      (contract) =>
        required.contracts.includes(contract.id) &&
        contract.providers.some((provider) => provider.bundleId === bundleId),
    );
  let booted = false;
  let exited = false;
  const supervisor = startSupervisor({
    router,
    relay,
    instances,
    resolved,
    commandOf: options.commandOf,
    digestOf,
    held: (key) => generation.holdsOf(key).length > 0,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timings === undefined ? {} : { timings: options.timings }),
    ...(options.hostPart === undefined ? {} : { hostPart: options.hostPart }),
    diagnostics,
    onQuarantine: (bundleId, reason) => {
      options.onQuarantine?.(bundleId, reason);

      if (booted && !exited && isRequired(bundleId)) {
        exited = true;
        console.error('Bundle recovery mode', { bundleId, reason });
        exit(1);
      }
    },
  });

  await supervisor.boot();
  booted = true;

  const doric: DoricCaller = {
    client: (service) => createClient(service, doricTransport(router)),
  };
  const isActive = (bundleId: string): boolean =>
    diagnostics.state(bundleId) === 'active';
  const missing = [
    ...required.contracts.filter(
      (id) =>
        !resolved.contracts.some(
          (contract) =>
            contract.id === id &&
            contract.providers.some(({ bundleId }) => isActive(bundleId)),
        ),
    ),
    ...required.bundles.filter((id) => !isActive(id)),
  ];
  const structuralFault =
    missing.length === 0
      ? undefined
      : `structural providers unavailable: ${missing.join(', ')}`;
  const storageActive = resolved.contracts
    .find((contract) => contract.id === StorageBackendV1.id)
    ?.providers.some(({ bundleId }) => isActive(bundleId));

  if (structuralFault === undefined && storageActive === true) {
    startup.stage('database_client');

    try {
      storage = await readStorageIdentity(router);
    } catch (error) {
      await supervisor.shutdown();
      await router.close();
      throw error;
    }
  }

  if (structuralFault === undefined && options.beforeListen !== undefined) {
    try {
      await options.beforeListen(doric);
    } catch (error) {
      await supervisor.shutdown();
      await router.close();
      throw error;
    }
  }

  let gateway: Gateway | undefined;

  if (structuralFault === undefined && options.publicAddress !== undefined) {
    try {
      gateway = await startGateway({
        address: options.publicAddress,
        index: options.index,
        resolved,
        router,
      });
    } catch (error) {
      await supervisor.shutdown();
      await router.close();
      throw error;
    }
  }

  // The gateway follows the resolution the supervisor adopts.
  const target: PublishTarget = {
    ...supervisor,
    adopt: (next) => {
      supervisor.adopt(next);
      current = next;
      gateway?.setResolution(next);
    },
  };
  let shuttingDown: Promise<void> | undefined;
  let publishing: Promise<unknown> = Promise.resolve();

  /** `beforeStop`, bounded by the shutdown deadline; never rejects. */
  const runBeforeStop = async (deadlineAt: number): Promise<void> => {
    const { beforeStop } = options;

    if (structuralFault !== undefined || beforeStop === undefined) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadlineAt - Date.now()),
    );
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve());
    });

    try {
      await Promise.race([
        (async () => beforeStop(doric, controller.signal))(),
        aborted,
      ]);
    } catch {
      // A failing `beforeStop` does not stop the shutdown.
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    client: doric.client,
    ...(structuralFault === undefined ? {} : { structuralFault }),
    routerPort: router.port,
    ...(gateway === undefined ? {} : { publicPort: gateway.port }),
    publish: (next) => {
      const result = publishing.then(() =>
        publish(target, next, digestOf).catch(
          (error: unknown): PublishResult => ({
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            bundles: [],
          }),
        ),
      );

      publishing = result;

      return result;
    },
    shutdown: () => {
      shuttingDown ??= (async () => {
        const deadlineAt = Date.now() + shutdownDeadlineMs;

        await gateway?.close();
        await runBeforeStop(deadlineAt);
        await supervisor.shutdown(deadlineAt);
        await router.close();
      })();

      return shuttingDown;
    },
  };
};

/** The host hooks of `doric.app.hooks/v1` the host runs. */
export type HostHook = 'onHostStartHook' | 'onHostReadyHook' | 'onHostStopHook';

/**
 * Runs `hook` of `doric.app.hooks/v1` as `doric`, through
 * `doric.client(HooksService)`: `Define{contract: 'doric.app.hooks/v1'}` (on
 * every run: the same id while `hooks/v1`'s provider keeps the definition, a
 * new one after it restarted), then `Run{contract, hook, input: anyPack(<hook's
 * input message>, empty)}`. `options.signal` and `options.timeoutMs` apply to
 * both calls.
 *
 * Resolves once `Run` answered: for the sequence hooks (`onHostStartHook`,
 * `onHostStopHook`) after every handler resolved, in the provider's order
 * (`onHostStopHook` reversed); for `onHostReadyHook` (observe) after every
 * handler was called, a handler's failure being the provider's report
 * (`hook_handler_failed`), not a rejection. No handler: `{}`.
 *
 * Rejects with a `ContractError`: a sequence handler's failure with its code
 * (later handlers not run); `unavailable` when no `hooks/v1` provider is
 * active within the wait; `cancelled` or `deadline_exceeded` from the
 * options; any other code `Define` or `Run` answers.
 */
export const runHostHook = async (
  doric: DoricCaller,
  hook: HostHook,
  options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<void> => {
  const hooks = doric.client(HooksService);
  const callOptions = options ?? {};
  const contract = appHooksContract;

  try {
    await hooks.define({ contract }, callOptions);
    await hooks.run(
      {
        contract,
        hook,
        input: anyPack(hookInputs[hook], create(hookInputs[hook])),
      },
      callOptions,
    );
  } catch (error) {
    throw error instanceof ConnectError ? fromConnectError(error) : error;
  }
};

/** The contract whose host hooks {@link runHostHook} runs. */
const appHooksContract = 'doric.app.hooks/v1';

/** Each host hook's input message. */
const hookInputs = {
  onHostStartHook: OnHostStartHookInputSchema,
  onHostReadyHook: OnHostReadyHookInputSchema,
  onHostStopHook: OnHostStopHookInputSchema,
} as const;

/** The `startup` sink when the host gives none: discards everything. */
const silentStartup: StartupSink = {
  stage: () => undefined,
  log: () => undefined,
};

/**
 * `index`, falling back to the platform contracts the router serves in
 * process (`doric.generation/v1`, `doric.log/v1`, `doric.catalog/v1`,
 * `doric.diagnostics/v1`, `doric.bundle/v1`) for what it lacks, so a bundle
 * reaches them whatever files the host indexed. Its `registry` holds
 * `index`'s files, those platform files and `doric.app.hooks/v1`'s file,
 * each with the files it imports; a file of `index` wins over a platform file
 * of the same name.
 */
const withPlatformContracts = (index: CatalogIndex): CatalogIndex => {
  const platform = createCatalogIndex([
    file_doric_platform_generation_v1_generation,
    file_doric_platform_log_v1_log,
    // Brings `doric.catalog/v1`, which it imports: naming that file here too
    // could add a second file of the same name (`bundle/contracts`).
    file_doric_platform_diagnostics_v1_diagnostics,
    file_doric_platform_bundle_v1_bundle,
    file_doric_platform_startup_v1_startup,
  ]);
  // Only in the registry: `doric.app.hooks/v1` is not served in process.
  const hooks = createCatalogIndex([file_doric_platform_app_hooks_v1_hooks]);

  return {
    method: (path) => index.method(path) ?? platform.method(path),
    service: (fullName) =>
      index.service(fullName) ?? platform.service(fullName),
    contract: (id) => index.contract(id) ?? platform.contract(id),
    desktopMethods: () => index.desktopMethods(),
    publicMethods: () => index.publicMethods(),
    registry: createFileRegistry(
      platform.registry,
      hooks.registry,
      index.registry,
    ),
  };
};

/**
 * The host's storage identity: `storage.backend/v1.Identity` served by
 * `router.serveGateway` with no client part, so under the caller `doric`.
 * Rejects with the call's `ContractError` when it fails.
 */
const readStorageIdentity = async (
  router: Pick<Router, 'serveGateway'>,
): Promise<StorageIdentity> => {
  const client = createClient(BackendService, doricTransport(router));

  try {
    const { storageIdentity } = await client.identity({});

    if (storageIdentity === undefined) {
      throw new ContractError(
        'internal',
        'storage.backend/v1.Identity answered no storage identity.',
      );
    }

    return {
      hostId: storageIdentity.hostId,
      storageGeneration: storageIdentity.storageGeneration,
    };
  } catch (error) {
    throw error instanceof ConnectError ? fromConnectError(error) : error;
  }
};

/**
 * The transport of the `doric` caller: each call served by
 * `router.serveGateway` with no client part.
 */
const doricTransport = (router: Pick<Router, 'serveGateway'>) =>
  createTransport({
    httpClient: async (request) => {
      const answer = await router.serveGateway(
        {
          httpVersion: '2.0',
          method: request.method,
          url: request.url,
          header: request.header,
          body: request.body ?? createAsyncIterable([]),
          signal: request.signal ?? new AbortController().signal,
        },
        undefined,
      );

      return {
        status: answer.status,
        header: answer.header ?? new Headers(),
        body: answer.body ?? createAsyncIterable([]),
        trailer: answer.trailer ?? new Headers(),
      };
    },
    baseUrl: 'http://doric',
    useBinaryFormat: true,
    interceptors: [],
    acceptCompression: [],
    sendCompression: null,
    compressMinBytes: 0,
    readMaxBytes: maxMessageBytes,
    writeMaxBytes: maxMessageBytes,
  });

/** The default `writeLog`: one JSON line per record on stdout. */
const writeLogLine: LogServiceOptions['write'] = (record, call) => {
  try {
    process.stdout.write(
      `${JSON.stringify({
        level: record.level,
        message: record.message,
        ...(record.fields === undefined ? {} : { fields: record.fields }),
        bundleId: record.bundleId,
        version: record.version,
        generation: record.generation,
        environment: record.environment,
        scope: record.scope,
        ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
        caller: call.caller,
      })}\n`,
    );
  } catch {
    // `writeLog` never throws.
  }
};
