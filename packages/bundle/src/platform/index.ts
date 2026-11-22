// The platform of a host (spec `docs/designs/grpc-processes.md`, sections 1,
// 6, 7 and 11): the router listener, the supervisor of the bundle processes
// and the gateway. Not exported from the package until
// phase 3 (`./platform`).

import { file_doric_platform_generation_v1_generation } from '../contracts/gen/doric/platform/generation/v1/generation_pb.js';
import { file_doric_platform_log_v1_log } from '../contracts/gen/doric/platform/log/v1/log_pb.js';
import type { QuarantineReason } from '../contracts/platform.js';
import type { ResolvedEnvironment } from '../runtime/catalog.js';
import type {
  DiagnosticsStore,
  HostStalledReport,
  RegistrationReplayReport,
} from '../runtime/diagnostics.js';
import { type CatalogIndex, createCatalogIndex } from './catalog-index.js';
import { type Gateway, startGateway } from './gateway/index.js';
import { InstanceTable } from './router/instances.js';
import { startRouter } from './router/listener.js';
import {
  createGenerationService,
  createLogService,
  type LogServiceOptions,
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
import type { Timings } from './supervisor/timings.js';

export {
  defaultPublicAddress,
  PublicListenerBindingError,
} from './gateway/index.js';
export type { PublishResult } from './supervisor/publish.js';
export type { SpawnCommand } from './supervisor/spawn.js';

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
   * `doric.log/v1`) are served whether or not it holds them. The gateway
   * serves the `DESKTOP` methods of it that a resolution provides
   * (`servedMethods`), and transcodes their JSON with its descriptors.
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
}

/** A booted platform. */
export interface Platform {
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
   * (`PublishTarget.adopt`): from then on it serves the `DESKTOP` methods
   * and the HTTP prefixes of `next`, without a restart, so the methods of a
   * bundle the publish adds are served (a call waits for its active
   * instance, as any call) and those of a bundle it removes answer
   * `UNIMPLEMENTED`; a call or proxied connection already in flight to a
   * draining instance finishes there (T2.16). `kernel_restart_required`
   * leaves the gateway as it was.
   */
  publish(next: ResolvedEnvironment): Promise<PublishResult>;
  /**
   * The host shutdown of section 7: closes the public listener, stops every
   * instance by dependency level in reverse activation order within the
   * shutdown deadline, then closes the router. Never rejects; a second call
   * resolves with the first.
   */
  shutdown(): Promise<void>;
}

/**
 * Binds the router, with the routes of `resolved` (`callRoutesOf`) and the
 * platform services `doric.generation/v1` and `doric.log/v1`, starts the
 * supervisor and boots `resolved` (the
 * supervisor's `boot`); then, with {@link PlatformOptions.publicAddress},
 * starts the gateway (`startGateway`) on `resolved` and `options.index`,
 * relaying to the router; resolves once every scheduled bundle is `active`
 * or quarantined and the public listener listens. Rejects with the
 * router's `RouterBindingError` when the router address cannot be bound,
 * and with `PublicListenerBindingError` when the public address cannot,
 * after shutting down what started; nothing is left running either way. A
 * required bundle quarantined during the boot does not reject: the host
 * reads the diagnostics, as today's boot fails at the stage `bundle_load`.
 */
export const startPlatform = async (
  options: PlatformOptions,
): Promise<Platform> => {
  const { diagnostics, resolved } = options;
  const required = options.required ?? { bundles: [], contracts: [] };
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const instances = new InstanceTable();
  const relay = createRouterRelay();
  const digestOf = options.digestOf ?? (() => '');
  const generation = createGenerationService({
    instances,
    signal: (from, topic, payload) =>
      router.sendPeerSignal(from, topic, payload),
  });
  const router = await startRouter({
    ...(options.routerAddress === undefined
      ? {}
      : { address: options.routerAddress }),
    index: withPlatformContracts(options.index),
    routes: callRoutesOf(resolved),
    platformServices: [
      generation,
      createLogService({ write: options.writeLog ?? writeLogLine }),
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

  let gateway: Gateway | undefined;

  if (options.publicAddress !== undefined) {
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
      gateway?.setResolution(next);
    },
  };
  let shuttingDown: Promise<void> | undefined;
  let publishing: Promise<unknown> = Promise.resolve();

  return {
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
        await gateway?.close();
        await supervisor.shutdown();
        await router.close();
      })();

      return shuttingDown;
    },
  };
};

/**
 * `index`, falling back to the platform contracts the router serves in
 * process (`doric.generation/v1`, `doric.log/v1`) for what it lacks, so a
 * bundle reaches them whatever files the host indexed.
 */
const withPlatformContracts = (index: CatalogIndex): CatalogIndex => {
  const platform = createCatalogIndex([
    file_doric_platform_generation_v1_generation,
    file_doric_platform_log_v1_log,
  ]);

  return {
    method: (path) => index.method(path) ?? platform.method(path),
    service: (fullName) =>
      index.service(fullName) ?? platform.service(fullName),
    contract: (id) => index.contract(id) ?? platform.contract(id),
    desktopMethods: () => index.desktopMethods(),
    registry: index.registry,
  };
};

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
