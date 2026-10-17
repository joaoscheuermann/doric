// The generation runner: one bundle generation in its own process. It is
// environment-generic and browser-safe; the Node entry (`process/runner-main`)
// and the desktop entry (stage 8) only add a transport and their loaders.

import { z } from 'zod';

import type { Activate } from '../contracts/context.js';
import { defineMethod, definePlatformService } from '../contracts/define.js';
import { isPlatformContract } from '../contracts/ids.js';
import {
  type CatalogSnapshot,
  catalogSnapshotSchema,
  type DiagnosticReport,
  type Diagnostics,
  DoricBundleV1,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  platformContracts,
} from '../contracts/platform.js';
import {
  activateEnvironment,
  catalogView,
  type PlatformLog,
} from './activation.js';
import type {
  CatalogEntry,
  ResolvedContract,
  ResolvedEnvironment,
} from './catalog.js';
import { type Composition, compositionSchema } from './composition.js';
import { DiagnosticsStore } from './diagnostics.js';
import {
  type Directory,
  type ProviderListener,
  type ProviderRecord,
  ServiceDirectory,
} from './directory.js';
import type { ErrorClassRegistry } from './envelope/errors.js';
import { ProcessLink, type Transport } from './envelope/link.js';
import {
  type ControlMessage,
  type RemoteProviderDescriptor,
  remoteProviderDescriptorSchema,
} from './envelope/messages.js';
import {
  announcedKey,
  describeRecord,
  matchesTarget,
  registerRemote,
} from './envelope/remote.js';
import type { SchemaValidators } from './envelope/validators.js';
import type { Principal, ServiceRuntime } from './principal.js';
import { createPrincipal } from './services.js';
import { PLATFORM_VERSION } from './version.js';

/** A catalog entry as the kernel sends it (plain data: structured clone). */
export type SerializedCatalogEntry = CatalogEntry;

/** What the kernel tells a new generation process (the `init` message). */
export interface GenerationInit {
  /** 'host' (stage 4) or 'desktopMain' (stage 8). */
  readonly environment: 'host' | 'desktopMain';
  readonly generation: number;
  readonly incarnation: number;
  readonly platformVersion: string;
  readonly composition: Composition;
  /** This process's entries, already resolved by the kernel (no re-resolution). */
  readonly entries: readonly SerializedCatalogEntry[];
  /** Activation order of this process. */
  readonly order: readonly string[];
  readonly contracts: readonly ResolvedContract[];
  /** Bundles already active elsewhere in this environment (dependency check). */
  readonly preActive: readonly string[];
  readonly kernelProviders: readonly RemoteProviderDescriptor[];
  /** 'remote': hooks/v1 lives in the kernel, so AppHooksV1 is defined before the first bundle. */
  readonly hooksProvider: 'remote' | 'local';
  readonly catalog: CatalogSnapshot;
}

const entrySchema = z.looseObject({
  id: z.string(),
  version: z.string(),
  source: z.union([
    z.object({ kind: z.literal('installed'), dir: z.string() }),
    z.object({ kind: z.literal('embedded') }),
  ]),
  state: z.enum(['scheduled', 'quarantined', 'disabled']),
  reasons: z.array(z.unknown()),
  dependencies: z.array(z.string()),
});

const contractSchema = z.looseObject({
  id: z.string(),
  environment: z.enum(['host', 'desktopMain', 'client']),
  cardinality: z.enum(['one', 'many']),
  providers: z.array(
    z.object({
      bundleId: z.string(),
      version: z.string(),
      bundleVersion: z.string(),
    }),
  ),
});

export const generationInitSchema = z.object({
  environment: z.enum(['host', 'desktopMain']),
  generation: z.number().int().positive(),
  incarnation: z.number().int().positive(),
  platformVersion: z.string(),
  composition: compositionSchema,
  entries: z.array(entrySchema),
  order: z.array(z.string()),
  contracts: z.array(contractSchema),
  preActive: z.array(z.string()),
  kernelProviders: z.array(remoteProviderDescriptorSchema),
  hooksProvider: z.enum(['remote', 'local']),
  catalog: catalogSnapshotSchema,
});

export interface RunnerOptions {
  readonly transport: Transport;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  readonly loadPart: (
    entry: SerializedCatalogEntry,
  ) => Promise<Activate | undefined>;
  readonly afterActivate?: (
    entry: SerializedCatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  /** Runs once the generation's whole phase has activated (D10-6). */
  readonly afterPhase?: (
    entry: SerializedCatalogEntry,
    principal: Principal,
  ) => Promise<void>;
  readonly now?: () => number;
}

/**
 * The generation's directory: every local provider a bundle registers is
 * announced to the kernel (`provide`, then `unprovide` on removal). Remote
 * records and the process's own `doric.*` providers are not announced.
 */
export class AnnouncingDirectory implements Directory {
  readonly #inner: Directory;
  readonly #announce: (message: ControlMessage) => void;

  constructor(inner: Directory, announce: (message: ControlMessage) => void) {
    this.#inner = inner;
    this.#announce = announce;
  }

  register(record: ProviderRecord): () => void {
    const unregister = this.#inner.register(record);

    if (record.origin === 'remote' || isPlatformContract(record.contractId)) {
      return unregister;
    }

    const descriptor = describeRecord(record);

    this.#announce({ kind: 'provide', descriptor });

    let registered = true;

    return () => {
      unregister();

      if (registered) {
        registered = false;
        this.#announce({
          kind: 'unprovide',
          contractId: record.contractId,
          bundleId: record.bundleId,
          ...(descriptor.key === undefined ? {} : { key: descriptor.key }),
        });
      }
    };
  }

  providers(contractId: string): readonly ProviderRecord[] {
    return this.#inner.providers(contractId);
  }

  active(contractId: string): ProviderRecord | undefined {
    return this.#inner.active(contractId);
  }

  isActive(record: ProviderRecord): boolean {
    return this.#inner.isActive(record);
  }

  subscribe(contractId: string, listener: ProviderListener): () => void {
    return this.#inner.subscribe(contractId, listener);
  }
}

const waitForInit = (transport: Transport): Promise<GenerationInit> =>
  new Promise((resolve, reject) => {
    const offClose = transport.onClose(() => {
      offMessage();
      reject(new Error('The kernel closed the channel before init.'));
    });
    const offMessage = transport.onMessage((message) => {
      const kind = (message as { kind?: unknown } | null)?.kind;

      if (kind !== 'init') {
        return;
      }

      offMessage();
      offClose();

      const parsed = generationInitSchema.safeParse(
        (message as { init?: unknown }).init,
      );

      if (parsed.success) {
        // The original value: parsing would drop undefined-valued keys.
        resolve((message as { init: GenerationInit }).init);
      } else {
        reject(
          new Error(`Invalid generation init: ${parsed.error.message}`, {
            cause: parsed.error,
          }),
        );
      }
    });
  });

/**
 * Diagnostics this process answers locally: its own bundles from its store,
 * the others (kernel bundles) from the latest catalog snapshot.
 */
const mirrorDiagnostics = (
  own: Diagnostics,
  catalog: CatalogSnapshot,
): Diagnostics => {
  const mine = new Map(own.bundles.map((bundle) => [bundle.id, bundle]));

  return {
    ...own,
    generation: catalog.generation,
    bundles: catalog.bundles.map(
      (bundle) =>
        mine.get(bundle.id) ?? {
          id: bundle.id,
          version: bundle.version,
          state: bundle.state,
          ...(bundle.phase === undefined ? {} : { phase: bundle.phase }),
          reasons: [...bundle.reasons],
        },
    ),
  };
};

/**
 * Runs one bundle generation: waits for `init`, activates this process's
 * bundles against the kernel's providers, announces `ready`, serves until
 * `stop`, deactivates in reverse order and answers `stopped`.
 */
export const runGeneration = async (options: RunnerOptions): Promise<void> => {
  const { transport } = options;
  const init = await waitForInit(transport);
  const resolved: ResolvedEnvironment = {
    environment: init.environment,
    generation: init.generation,
    composition: init.composition,
    issues: [],
    entries: init.entries,
    order: init.order,
    contracts: init.contracts,
  };
  const controller = new AbortController();
  const diagnostics = new DiagnosticsStore({
    generation: init.generation,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  diagnostics.load(resolved);

  let catalog = init.catalog;
  let link: ProcessLink | undefined;
  let pushScheduled = false;
  const send = (message: ControlMessage) => {
    try {
      link?.sendControl(message);
    } catch {
      // The kernel is gone; this process ends with its channel.
    }
  };
  const pushDiagnostics = () => {
    pushScheduled = false;
    send({ kind: 'diagnostics', snapshot: diagnostics.snapshot() });
  };
  const schedulePush = () => {
    if (!pushScheduled) {
      pushScheduled = true;
      queueMicrotask(pushDiagnostics);
    }
  };
  const report = (entry: DiagnosticReport) => {
    diagnostics.report(entry);
    schedulePush();
  };
  const inner = new ServiceDirectory();
  const directory = new AnnouncingDirectory(inner, send);
  const runtime: ServiceRuntime = {
    directory,
    catalog: catalogView(resolved),
    environment: init.environment,
    generation: init.generation,
    operationGeneration: init.generation,
    generationSignal: controller.signal,
    report,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const principals = new Map<string, Principal>();
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });

  principals.set(platform.bundleId, platform);
  link = new ProcessLink({
    transport,
    side: 'generation',
    generation: init.generation,
    incarnation: init.incarnation,
    validators: options.validators,
    errors: options.errors,
    resolve: ({ contract, ...target }) =>
      inner.providers(contract).find((record) => matchesTarget(record, target)),
    principalOf: (bundleId) => principals.get(bundleId),
    report,
    generationSignal: controller.signal,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const processLink = link;
  const specs = platformContracts;

  // Local platform providers: synchronous in-process, so answered here.
  platform.services.provide(
    definePlatformService(DoricCatalogV1, {
      get: defineMethod({
        input: specs['doric.catalog/v1'].methods.get.input,
        output: specs['doric.catalog/v1'].methods.get.output,
        execute: () => catalog,
      }),
    }),
  );
  platform.services.provide(
    definePlatformService(DoricDiagnosticsV1, {
      get: defineMethod({
        input: specs['doric.diagnostics/v1'].methods.get.input,
        output: specs['doric.diagnostics/v1'].methods.get.output,
        execute: () => mirrorDiagnostics(diagnostics.snapshot(), catalog),
      }),
      report: defineMethod({
        input: specs['doric.diagnostics/v1'].methods.report.input,
        output: specs['doric.diagnostics/v1'].methods.report.output,
        execute: (entry: DiagnosticReport) => report(entry),
      }),
    }),
  );
  platform.services.provide(
    definePlatformService(DoricBundleV1, {
      describe: defineMethod({
        input: specs['doric.bundle/v1'].methods.describe.input,
        output: specs['doric.bundle/v1'].methods.describe.output,
        execute: (_input, call) => ({
          bundleId: call.caller.bundleId,
          version: call.caller.version,
          generation: call.caller.generation,
          environment: runtime.environment,
        }),
      }),
    }),
  );

  // Every other kernel provider, in the order the kernel listed them; the
  // kernel announces later ones with `provide` and `unprovide` controls.
  const kernelRecords = new Map<string, () => void>();
  const provideKernel = (descriptor: RemoteProviderDescriptor) => {
    const key = announcedKey(descriptor);

    kernelRecords.get(key)?.();
    kernelRecords.delete(key);

    try {
      kernelRecords.set(
        key,
        registerRemote(processLink, directory, descriptor),
      );
    } catch (error) {
      report({
        bundleId: descriptor.bundleId,
        kind: 'registration_failed',
        message: error instanceof Error ? error.message : String(error),
        details: { contract: descriptor.contractId },
      });
    }
  };

  for (const descriptor of init.kernelProviders) {
    provideKernel(descriptor);
  }

  let stopRequested: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    stopRequested = resolve;
  });

  processLink.onControl((message) => {
    if (message.kind === 'catalog') {
      catalog = message.snapshot;
    } else if (message.kind === 'provide') {
      provideKernel(message.descriptor);
    } else if (message.kind === 'unprovide') {
      const key = announcedKey(message);

      kernelRecords.get(key)?.();
      kernelRecords.delete(key);
    } else if (message.kind === 'stop') {
      stopRequested?.();
    }
  });
  processLink.onClose(() => {
    controller.abort();
    stopRequested?.();
  });

  const log: PlatformLog = {
    info: (fields, message) =>
      send({ kind: 'platform-log', level: 'info', fields, message }),
    warn: (fields, message) =>
      send({ kind: 'platform-log', level: 'warn', fields, message }),
    error: (fields, message) =>
      send({ kind: 'platform-log', level: 'error', fields, message }),
  };
  // Refusals of a bundle's optimistic registrations wait for `settle` while
  // it activates; afterwards they are reported to diagnostics.
  let endActivating: (() => void) | undefined;
  const activation = await activateEnvironment({
    resolved,
    runtime,
    platform,
    diagnostics,
    preActive: init.preActive,
    hooksProvider: init.hooksProvider,
    onPrincipal: (entry, principal) => {
      principals.set(entry.id, principal);
      endActivating?.();
      endActivating = processLink.activating(entry.id);
      pushDiagnostics();
    },
    loadPart: (entry) => options.loadPart(entry),
    ...(options.afterActivate === undefined
      ? {}
      : { afterActivate: options.afterActivate }),
    ...(options.afterPhase === undefined
      ? {}
      : {
          afterPhase: async (entry, principal) => {
            // Refusals of these registrations are collected by `settle` too.
            const end = processLink.activating(entry.id);

            try {
              await options.afterPhase?.(entry, principal);
              await processLink.settle(entry.id);
            } finally {
              end();
            }
          },
        }),
    settle: (entry) => processLink.settle(entry.id),
    log,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  endActivating?.();

  for (const [id, principal] of [...principals]) {
    if (principal.closed) {
      principals.delete(id);
    }
  }

  pushDiagnostics();
  send({ kind: 'ready', order: [...resolved.order] });

  await stopped;

  if (processLink.closeReason === undefined) {
    await activation.stop();
    await platform.scope.dispose();
    platform.close();
    pushDiagnostics();
    send({ kind: 'stopped' });
  }

  controller.abort();
  processLink.close();
};
