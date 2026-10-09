import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { basicContracts } from '../contracts/basic/index.js';
import {
  StorageBackendV1,
  type StorageIdentity,
} from '../contracts/basic/storage.js';
import { type CallScope, generationOf } from '../contracts/call.js';
import type { Activate, Services } from '../contracts/context.js';
import { ContractError } from '../contracts/error.js';
import { platformContracts } from '../contracts/platform.js';
import {
  type HostPlatform,
  importHostPart,
  readHostCatalog,
  registerInstalledResources,
  type StartHostOptions,
} from '../loader/activate.js';
import { type EmbeddedBundle, embeddedId } from '../loader/catalog.js';
import type { InstalledBundle } from '../loader/discover.js';
import { providePlatformServices } from '../loader/platform.js';
import {
  type ActivationResult,
  activateEnvironment,
  catalogView,
} from '../runtime/activation.js';
import { createHopCall } from '../runtime/call.js';
import type { CatalogEntry } from '../runtime/catalog.js';
import { DiagnosticsStore } from '../runtime/diagnostics.js';
import { ServiceDirectory } from '../runtime/directory.js';
import { createErrorClassRegistry } from '../runtime/envelope/errors.js';
import type { RemoteProviderDescriptor } from '../runtime/envelope/messages.js';
import { describeRecord } from '../runtime/envelope/remote.js';
import { LayeredDirectory } from '../runtime/layered-directory.js';
import type { Principal, ServiceRuntime } from '../runtime/principal.js';
import type { GenerationInit } from '../runtime/runner.js';
import { createPrincipal } from '../runtime/services.js';
import { PLATFORM_VERSION } from '../runtime/version.js';
import { ajvValidators } from './ajv.js';
import {
  type GenerationManager,
  HostGenerations,
  type SpawnedGeneration,
} from './manager.js';
import { childTransport } from './node-transport.js';
import { partitionCatalog, withOrder } from './partition.js';

export type {
  ExecutionRef,
  GenerationLease,
  GenerationManager,
  GenerationSummary,
  LostGeneration,
  PublishResult,
  SpawnedGeneration,
} from './manager.js';

export interface StartKernelOptions extends StartHostOptions {
  /** Default: the compiled `runner-main.js` next to this module. */
  readonly runnerPath?: string;
  /** Error classes rebuilt with their prototype (agents/doric passes ToolErrorObject). */
  readonly errorClasses?: readonly (abstract new (
    ...args: never[]
  ) => Error)[];
  /** Consecutive start attempts before a generation is `failed`. Default 3. */
  readonly startAttempts?: number;
  /** Orderly stop budget before SIGKILL. Default 10_000 ms. */
  readonly stopTimeoutMs?: number;
  /** Test seam: how a generation process is created (default: fork). */
  readonly spawn?: (init: GenerationInit) => SpawnedGeneration;
}

export interface KernelPlatform extends HostPlatform {
  readonly generations: GenerationManager;
  /** Kernel-internal doric principal pinned to generation N (its view). */
  view(generation: number): Services;
}

/** Platform providers the generation process answers itself. */
const localInGeneration = new Set([
  'doric.catalog/v1',
  'doric.diagnostics/v1',
  'doric.bundle/v1',
]);

const messageOf = (error: unknown): string => {
  const parts: string[] = [];

  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    parts.push(current.message);
  }

  return parts.length > 0 ? parts.join(': ') : String(error);
};

/** Forks the compiled runner with V8 serialization over IPC (D4-5). */
export const forkGeneration =
  (runnerPath: string) =>
  (_init: GenerationInit): SpawnedGeneration => {
    const child = fork(runnerPath, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });

    return {
      transport: childTransport(child),
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      kill: (signal) => {
        child.kill(signal);
      },
    };
  };

export const defaultRunnerPath = (): string =>
  fileURLToPath(new URL('./runner-main.js', import.meta.url));

/**
 * Boots the host kernel: resolves one catalog, activates the kernel partition
 * (foundation, core, embedded) in this process and starts generation 1 of
 * the installed `others` in a child process. Resolves once that generation
 * is active, or failed and replaced by an empty view.
 */
export const startKernel = async (
  options: StartKernelOptions,
): Promise<KernelPlatform> => {
  const now = options.now;
  const controller = new AbortController();
  const { installed, resolved: raw } = await readHostCatalog(options, 1);
  const partition = partitionCatalog(raw);
  const resolved = partition.published;
  const diagnostics = new DiagnosticsStore({
    generation: resolved.generation,
    ...(now === undefined ? {} : { now }),
  });

  diagnostics.load(resolved);

  for (const entry of resolved.entries) {
    if (entry.state === 'quarantined') {
      options.log.warn(
        { bundleId: entry.id, reasons: entry.reasons },
        'Bundle quarantined',
      );
    }
  }

  const kernelDirectory = new ServiceDirectory();
  const activeView = new LayeredDirectory(kernelDirectory);
  const runtime: ServiceRuntime = {
    directory: activeView,
    catalog: catalogView(resolved),
    environment: 'host',
    generation: resolved.generation,
    operationGeneration: 0,
    generationSignal: controller.signal,
    report: (entry) => diagnostics.report(entry),
    ...(now === undefined ? {} : { now }),
  };
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });
  const errors = createErrorClassRegistry();

  for (const errorClass of options.errorClasses ?? []) {
    errors.register(errorClass as never);
  }

  let storage: StorageIdentity | undefined;
  let principals: ReadonlyMap<string, Principal> = new Map();
  let kernelActivation: ActivationResult | undefined;
  const platformCall = (
    generation: number,
    scope?: CallScope,
    signal?: AbortSignal,
    deadline?: number,
  ) =>
    createHopCall({
      caller: platform.caller,
      ...(scope === undefined ? {} : { useScope: scope }),
      arg: {
        ...(signal === undefined ? {} : { signal }),
        ...(deadline === undefined ? {} : { deadline }),
      },
      generation,
      generationSignal:
        manager.generationSignal(generation) ?? controller.signal,
      ...(now === undefined ? {} : { now }),
    });
  const kernelProviders = (): readonly RemoteProviderDescriptor[] => {
    const ids = new Set<string>([
      ...Object.keys(platformContracts),
      ...Object.keys(basicContracts),
      ...resolved.contracts.map(({ id }) => id),
    ]);
    const descriptors: RemoteProviderDescriptor[] = [];

    for (const id of ids) {
      if (localInGeneration.has(id)) {
        continue;
      }

      for (const record of kernelDirectory.providers(id)) {
        if (record.origin === 'remote') {
          continue;
        }

        try {
          descriptors.push(describeRecord(record));
        } catch (error) {
          diagnostics.report({
            bundleId: record.bundleId,
            kind: 'provide_failed',
            message: messageOf(error),
            details: { contract: id },
          });
        }
      }
    }

    return descriptors;
  };
  const manager: HostGenerations = new HostGenerations({
    environment: 'host',
    kernelDirectory,
    activeView,
    kernelDiagnostics: diagnostics,
    platform,
    get kernelActive() {
      return [...principals.keys()];
    },
    kernelProviders,
    principalOf: (bundleId) =>
      bundleId === platform.bundleId ? platform : principals.get(bundleId),
    appHooks: () => kernelActivation?.appHooks(),
    platformCall: (generation, scope, signal) =>
      platformCall(generation, scope, signal),
    storage: () => (storage === undefined ? undefined : { ...storage }),
    readCatalog: async (generation) =>
      (await readHostCatalog(options, generation)).resolved,
    spawn:
      options.spawn ??
      forkGeneration(options.runnerPath ?? defaultRunnerPath()),
    validators: ajvValidators(),
    errors,
    startAttempts: options.startAttempts ?? 3,
    stopTimeoutMs: options.stopTimeoutMs ?? 10_000,
    log: options.log,
    ...(now === undefined ? {} : { now }),
  });

  providePlatformServices(platform, {
    snapshot: (call) =>
      manager.catalogOf(manager.liveFor(generationOf(call)), resolved),
    diagnostics,
    diagnosticsFor: (call) =>
      manager.diagnosticsOf(manager.liveFor(generationOf(call))),
    sink: options.sink,
    generation: {
      describe: (call) => manager.describeFor(generationOf(call)),
      hold: (execution, call) =>
        manager.holdFor(generationOf(call), { ...execution }),
    },
  });

  const installedById = new Map<string, InstalledBundle>();

  for (const bundle of installed) {
    const id = bundle.read?.manifest.id;

    if (id !== undefined && !installedById.has(id)) {
      installedById.set(id, bundle);
    }
  }

  const embedded: readonly EmbeddedBundle[] = options.embedded ?? [];
  const embeddedById = new Map(
    embedded.map((bundle) => [embeddedId(bundle), bundle]),
  );
  const activation = await activateEnvironment({
    resolved: withOrder(resolved, partition.kernelOrder),
    runtime,
    platform,
    diagnostics,
    // Generation bundles satisfy kernel dependencies through the catalog
    // (X-8): their providers resolve in the active view at call time.
    preActive: partition.generationOrder,
    loadPart: async (entry: CatalogEntry) => {
      if (entry.source.kind === 'embedded') {
        return embeddedById.get(entry.id)?.host?.activate as
          | Activate
          | undefined;
      }

      return await importHostPart(entry.source.dir);
    },
    afterActivate: async (entry, principal) => {
      if (entry.source.kind !== 'installed') {
        return;
      }

      await registerInstalledResources(
        entry.source.dir,
        installedById.get(entry.id)?.read?.legacy,
        principal,
      );
    },
    log: options.log,
    ...(now === undefined ? {} : { now }),
  });

  principals = activation.principals;
  kernelActivation = activation;

  if (diagnostics.mode === 'recovery') {
    const final = diagnostics.snapshot();

    options.log.error(
      {
        reason: final.recovery?.reason,
        bundles: final.bundles.map(({ id, state, reasons }) => ({
          id,
          state,
          reasons,
        })),
      },
      'Bundle recovery mode',
    );
  } else {
    await manager.boot(raw);
  }

  const views = new Map<number, Principal>();
  let readied: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let identity: Promise<StorageIdentity> | undefined;

  return {
    get mode() {
      return diagnostics.mode;
    },
    get generation() {
      return manager.activeGeneration ?? resolved.generation;
    },
    generations: manager,
    services: platform.services,
    call: (callOptions = {}) =>
      platformCall(
        callOptions.generation ?? 0,
        callOptions.scope,
        callOptions.signal,
        callOptions.deadline,
      ),
    catalog: () => manager.catalogOf(manager.liveFor(0), resolved),
    storageIdentity: async () => {
      if (
        identity === undefined &&
        kernelDirectory.active(StorageBackendV1.id) === undefined
      ) {
        return undefined;
      }

      identity ??= platform.services
        .use(StorageBackendV1)
        .identity()
        .then((resolvedIdentity) => {
          storage = resolvedIdentity;

          return resolvedIdentity;
        });

      const pending = identity;

      try {
        return await pending;
      } catch (error) {
        if (identity === pending) {
          identity = undefined;
        }

        throw error;
      }
    },
    diagnostics: () => manager.diagnosticsOf(manager.liveFor(0)),
    view: (generation) => {
      const directory = manager.viewOf(generation);

      if (directory === undefined) {
        throw new ContractError(
          'unavailable',
          `Generation ${generation} is not live.`,
          { generation },
        );
      }

      let principal = views.get(generation);

      if (
        principal === undefined ||
        principal.runtime.directory !== directory
      ) {
        principal = createPrincipal(
          {
            ...runtime,
            directory,
            operationGeneration: generation,
            generationSignal:
              manager.generationSignal(generation) ?? controller.signal,
          },
          {
            bundleId: 'doric',
            version: PLATFORM_VERSION,
            provides: 'any',
            requires: 'any',
          },
        );
        views.set(generation, principal);
      }

      return principal.services;
    },
    ready: () => {
      readied ??= (async () => {
        const hooks = activation.appHooks();
        const active = manager.activeGeneration;

        if (diagnostics.mode === 'recovery' || hooks === undefined) {
          return;
        }

        try {
          await hooks.onHostReadyHook.execute({}, platformCall(active ?? 0));
        } catch (error) {
          diagnostics.report({
            bundleId: platform.bundleId,
            kind: 'hook_execute_failed',
            message: messageOf(error),
            details: { hook: 'onHostReadyHook' },
          });
        }
      })();

      return readied;
    },
    stop: () => {
      stopping ??= (async () => {
        await manager.stop();
        await activation.stop();
        await platform.scope.dispose();
        platform.close();
        controller.abort();
      })();

      return stopping;
    },
  };
};
