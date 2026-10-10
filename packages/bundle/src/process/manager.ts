import type { HookHandle } from '../contracts/basic/hooks.js';
import type { Call, CallScope } from '../contracts/call.js';
import type { Disposable } from '../contracts/context.js';
import { ContractError } from '../contracts/error.js';
import type {
  AppHooksV1,
  CatalogSnapshot,
  DiagnosticBundle,
  Diagnostics,
  ExecutionRef,
  GenerationDescription,
  GenerationState,
} from '../contracts/platform.js';
import { catalogSnapshot, statesOf } from '../loader/platform.js';
import type { PlatformLog } from '../runtime/activation.js';
import type { CatalogEntry, ResolvedEnvironment } from '../runtime/catalog.js';
import { DiagnosticsStore } from '../runtime/diagnostics.js';
import { type ProviderRecord, ServiceDirectory } from '../runtime/directory.js';
import type { ErrorClassRegistry } from '../runtime/envelope/errors.js';
import {
  type LinkCloseReason,
  ProcessLink,
  type Transport,
} from '../runtime/envelope/link.js';
import type {
  ControlMessage,
  RemoteProviderDescriptor,
} from '../runtime/envelope/messages.js';
import {
  announcedKey,
  matchesTarget,
  registerRemote,
} from '../runtime/envelope/remote.js';
import type { SchemaValidators } from '../runtime/envelope/validators.js';
import { LayeredDirectory } from '../runtime/layered-directory.js';
import type { Principal } from '../runtime/principal.js';
import type { GenerationInit } from '../runtime/runner.js';
import { toDisposable } from '../runtime/scope.js';
import { PLATFORM_VERSION } from '../runtime/version.js';
import {
  isKernelResident,
  kernelSignature,
  partitionCatalog,
} from './partition.js';

export type { ExecutionRef } from '../contracts/platform.js';

/** A generation process as the kernel created it. */
export interface SpawnedGeneration {
  readonly transport: Transport;
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): void;
}

export interface GenerationLease {
  readonly generation: number;
  /** The prompt call, pinned to this generation (caller doric, new trace). */
  call(options: {
    readonly scope?: CallScope;
    readonly signal?: AbortSignal;
  }): Call;
  /** Idempotent. */
  release(): void;
}

export interface LostGeneration {
  readonly generation: number;
  readonly incarnation: number;
  readonly executions: readonly ExecutionRef[];
}

export type PublishResult =
  | { readonly status: 'published'; readonly generation: number }
  | { readonly status: 'kernel_restart_required'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface GenerationSummary {
  readonly generation: number;
  readonly incarnation: number;
  readonly state: GenerationState;
  readonly pid?: number;
  readonly executions: number;
}

export interface GenerationManager {
  /** Pins one execution to the active generation, waiting (abortably) for one. */
  acquire(
    execution: ExecutionRef,
    signal: AbortSignal,
  ): Promise<GenerationLease>;
  /** Re-discovers installed bundles and the composition and switches generation. */
  publish(): Promise<PublishResult>;
  /** Fired synchronously when a generation process exits unexpectedly (before pending calls reject). */
  onLost(listener: (lost: LostGeneration) => void): () => void;
  /** Fired after a generation became active (boot, publish, respawn). */
  onActive(listener: (generation: number) => void): () => void;
  describe(): readonly GenerationSummary[];
  /** Stops every live generation (orderly, then SIGKILL after stopTimeoutMs). */
  stop(): Promise<void>;
}

/** What the manager needs from the kernel. */
export interface ManagerDependencies {
  readonly environment: 'host';
  readonly kernelDirectory: ServiceDirectory;
  readonly activeView: LayeredDirectory;
  readonly kernelDiagnostics: DiagnosticsStore;
  readonly platform: Principal;
  readonly kernelActive: readonly string[];
  readonly kernelProviders: () => readonly RemoteProviderDescriptor[];
  readonly principalOf: (bundleId: string) => Principal | undefined;
  readonly appHooks: () => HookHandle<typeof AppHooksV1> | undefined;
  /** A platform call (caller doric, new trace) pinned to a generation. */
  readonly platformCall: (
    generation: number,
    scope?: CallScope,
    signal?: AbortSignal,
  ) => Call;
  readonly storage: () => CatalogSnapshot['storage'];
  readonly readCatalog: (generation: number) => Promise<ResolvedEnvironment>;
  readonly spawn: (init: GenerationInit) => SpawnedGeneration;
  readonly validators: SchemaValidators;
  readonly errors: ErrorClassRegistry;
  readonly startAttempts: number;
  readonly stopTimeoutMs: number;
  readonly log: PlatformLog;
  readonly now?: () => number;
}

type Hold = ExecutionRef | { readonly window: string };

interface Live {
  readonly generation: number;
  incarnation: number;
  state: GenerationState;
  /** The published catalog of this generation (kernel order, then generation order). */
  readonly resolved: ResolvedEnvironment;
  readonly generationOrder: readonly string[];
  readonly generationEntries: readonly CatalogEntry[];
  records: ServiceDirectory;
  view: LayeredDirectory;
  controller: AbortController;
  link?: ProcessLink;
  spawned?: SpawnedGeneration;
  readonly holds: Map<string, Hold>;
  /** The latest diagnostics the process pushed. */
  child?: Diagnostics;
  /** Set once start attempts are exhausted: its bundles are quarantined. */
  failure?: string;
  stopping: boolean;
  exited?: Promise<void>;
  /**
   * The kernel providers this process knows, by `contract\0bundle\0key`, as the
   * descriptor JSON last sent (init, then `provide`/`unprovide` controls).
   */
  announced?: Map<string, string>;
  /** Set once the process announced `ready`. */
  ready?: boolean;
}

const providerKey = announcedKey;

const isExecution = (hold: Hold): hold is ExecutionRef => 'promptId' in hold;

const describeExit = (reason: LinkCloseReason): string =>
  reason.kind === 'exited'
    ? `code ${reason.code === null ? 'null' : reason.code}, signal ${reason.signal ?? 'null'}`
    : reason.kind;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const byTime = <T extends { readonly at: string }>(items: T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      left.item.at < right.item.at
        ? -1
        : left.item.at > right.item.at
          ? 1
          : left.index - right.index,
    )
    .map(({ item }) => item);

/**
 * Generations of the host: one process each, started from a resolved
 * catalog, switched on `publish`, drained by holds, respawned after a crash.
 */
export class HostGenerations implements GenerationManager {
  readonly #deps: ManagerDependencies;
  readonly #lives = new Map<number, Live>();
  readonly #lost = new Set<(lost: LostGeneration) => void>();
  readonly #activeListeners = new Set<(generation: number) => void>();
  readonly #waiting = new Set<() => void>();
  #active: Live | undefined;
  #latest: Live | undefined;
  #counter = 0;
  #holdCounter = 0;
  #stopping: Promise<void> | undefined;
  #publishing: Promise<PublishResult> | undefined;
  #kernelSignature: string | undefined;

  #syncScheduled = false;

  constructor(deps: ManagerDependencies) {
    this.#deps = deps;
    // Kernel providers registered or removed after a generation started are
    // announced to it (G-1 follow-up of stage 4): a batch per microtask.
    deps.kernelDirectory.observe({
      added: (record) => {
        if (record.origin !== 'remote') {
          this.#scheduleKernelSync();
        }
      },
      removed: (record) => {
        if (record.origin !== 'remote') {
          this.#scheduleKernelSync();
        }
      },
    });
  }

  #scheduleKernelSync(): void {
    if (this.#syncScheduled) {
      return;
    }

    this.#syncScheduled = true;
    queueMicrotask(() => {
      this.#syncScheduled = false;

      for (const live of this.#lives.values()) {
        this.#syncKernelProviders(live);
      }
    });
  }

  /** Sends a ready process the kernel providers it does not know yet. */
  #syncKernelProviders(live: Live): void {
    const { link, announced } = live;

    if (
      link === undefined ||
      announced === undefined ||
      live.ready !== true ||
      live.state === 'stopped' ||
      link.closeReason !== undefined
    ) {
      return;
    }

    const current = new Map<string, RemoteProviderDescriptor>();

    for (const descriptor of this.#deps.kernelProviders()) {
      current.set(providerKey(descriptor), descriptor);
    }

    try {
      for (const [key, descriptor] of current) {
        const text = JSON.stringify(descriptor);

        if (announced.get(key) !== text) {
          link.sendControl({ kind: 'provide', descriptor });
          announced.set(key, text);
        }
      }

      for (const key of [...announced.keys()]) {
        if (!current.has(key)) {
          const [contractId, bundleId, record] = key.split('\u0000') as [
            string,
            string,
            string,
          ];

          link.sendControl({
            kind: 'unprovide',
            contractId,
            bundleId,
            ...(record === '' ? {} : { key: record }),
          });
          announced.delete(key);
        }
      }
    } catch {
      // The process is gone; its close is handled on its own.
    }
  }

  /** Whether generation bundles of `live` provide `contractId`. */
  #generationProvides(live: Live, contractId: string): boolean {
    const contract = live.resolved.contracts.find(
      ({ id }) => id === contractId,
    );

    return (
      contract?.providers.some(({ bundleId }) =>
        live.generationOrder.includes(bundleId),
      ) ?? false
    );
  }

  /**
   * G-11: while no generation is active (a respawn window), a kernel call to
   * a contract the generation provides waits for the next activation instead
   * of answering `unavailable`; abortable by its call signal.
   */
  awaitProvider(
    contractId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> | undefined {
    const latest = this.#latest;

    if (
      this.#active !== undefined ||
      this.#stopping !== undefined ||
      latest === undefined ||
      !this.#generationProvides(latest, contractId)
    ) {
      return undefined;
    }

    if (signal?.aborted === true) {
      return Promise.reject(signal.reason);
    }

    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', abort);
        this.#waiting.delete(wake);
        resolve();
      };
      const abort = () => {
        this.#waiting.delete(wake);
        reject(signal?.reason);
      };

      this.#waiting.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /** The generation an operation sees: its own when live, else the active one. */
  liveFor(generation: number): Live | undefined {
    const pinned = generation > 0 ? this.#lives.get(generation) : undefined;

    return pinned !== undefined && pinned.state !== 'stopped'
      ? pinned
      : (this.#active ?? this.#latest);
  }

  /** The kernel-side directory of generation N: kernel records, then N's. */
  viewOf(generation: number): LayeredDirectory | undefined {
    return this.#lives.get(generation)?.view;
  }

  generationSignal(generation: number): AbortSignal | undefined {
    return this.#lives.get(generation)?.controller.signal;
  }

  get activeGeneration(): number | undefined {
    return this.#active?.generation;
  }

  // Diagnostics and catalog per generation ------------------------------------

  diagnosticsOf(live: Live | undefined): Diagnostics {
    const kernel = this.#deps.kernelDiagnostics.snapshot();

    if (live === undefined) {
      return kernel;
    }

    const base = new DiagnosticsStore({ generation: live.generation });

    base.load(live.resolved);

    const own = base.snapshot();
    const kernelById = new Map<string, DiagnosticBundle>();

    for (const bundle of kernel.bundles) {
      if (!kernelById.has(bundle.id)) {
        kernelById.set(bundle.id, bundle);
      }
    }

    const childById = new Map(
      (live.child?.bundles ?? []).map((bundle) => [bundle.id, bundle]),
    );
    const failed = new Set(
      live.failure === undefined
        ? []
        : live.generationEntries.map(({ id }) => id),
    );
    const seen = new Set<string>();
    const bundles = live.resolved.entries.map((entry, index) => {
      const fallback = own.bundles[index] as DiagnosticBundle;

      if (entry.manifest === undefined || seen.has(entry.id)) {
        return fallback;
      }

      seen.add(entry.id);

      if (isKernelResident(entry)) {
        return kernelById.get(entry.id) ?? fallback;
      }

      if (failed.has(entry.id)) {
        return {
          id: entry.id,
          version: entry.version,
          state: 'quarantined' as const,
          ...(entry.phase === undefined ? {} : { phase: entry.phase }),
          reasons: [
            ...entry.reasons,
            {
              code: 'generation_failed' as const,
              message: live.failure as string,
            },
          ],
        };
      }

      return childById.get(entry.id) ?? fallback;
    });

    return {
      generation: live.generation,
      mode: kernel.mode,
      ...(kernel.recovery === undefined ? {} : { recovery: kernel.recovery }),
      issues: own.issues,
      bundles,
      errors: byTime([...kernel.errors, ...(live.child?.errors ?? [])]),
      consumers: own.consumers,
    };
  }

  catalogOf(
    live: Live | undefined,
    fallback: ResolvedEnvironment,
  ): CatalogSnapshot {
    return catalogSnapshot(
      live?.resolved ?? fallback,
      statesOf(this.diagnosticsOf(live)),
      this.#deps.storage(),
    );
  }

  #pushCatalogs(): void {
    for (const live of this.#lives.values()) {
      if (live.link === undefined || live.state === 'stopped') {
        continue;
      }

      try {
        live.link.sendControl({
          kind: 'catalog',
          snapshot: this.catalogOf(live, live.resolved),
        });
      } catch {
        // The process is gone; its close is handled on its own.
      }
    }
  }

  // doric.generation/v1 ---------------------------------------------------------

  describeFor(generation: number): GenerationDescription {
    const live = this.liveFor(generation);

    if (live === undefined) {
      throw new ContractError('unavailable', 'No bundle generation is active.');
    }

    return {
      generation: live.generation,
      incarnation: live.incarnation,
      state: live.state,
    };
  }

  holdFor(generation: number, hold: Hold): Disposable {
    const live = this.liveFor(generation);

    if (live === undefined || live.state === 'stopped') {
      throw new ContractError('unavailable', 'No bundle generation is active.');
    }

    return this.#hold(live, hold);
  }

  #hold(live: Live, hold: Hold): Disposable {
    this.#holdCounter += 1;

    const key = String(this.#holdCounter);

    live.holds.set(key, hold);

    return toDisposable(() => {
      if (live.holds.delete(key)) {
        this.#maybeStop(live);
      }
    });
  }

  // GenerationManager -----------------------------------------------------------

  onLost(listener: (lost: LostGeneration) => void): () => void {
    this.#lost.add(listener);

    return () => this.#lost.delete(listener);
  }

  onActive(listener: (generation: number) => void): () => void {
    this.#activeListeners.add(listener);

    return () => this.#activeListeners.delete(listener);
  }

  describe(): readonly GenerationSummary[] {
    return [...this.#lives.values()].map((live) => ({
      generation: live.generation,
      incarnation: live.incarnation,
      state: live.state,
      ...(live.spawned?.pid === undefined ? {} : { pid: live.spawned.pid }),
      executions: [...live.holds.values()].filter(isExecution).length,
    }));
  }

  async acquire(
    execution: ExecutionRef,
    signal: AbortSignal,
  ): Promise<GenerationLease> {
    while (this.#active === undefined) {
      signal.throwIfAborted();

      if (this.#stopping !== undefined) {
        throw new ContractError('unavailable', 'The host is stopping.');
      }

      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', abort);
          this.#waiting.delete(wake);
          resolve();
        };
        const abort = () => {
          this.#waiting.delete(wake);
          reject(signal.reason);
        };

        this.#waiting.add(wake);
        signal.addEventListener('abort', abort, { once: true });
      });
    }

    const live = this.#active;
    const held = this.#hold(live, { ...execution });

    return {
      generation: live.generation,
      call: (options) =>
        this.#deps.platformCall(live.generation, options.scope, options.signal),
      release: () => held.dispose(),
    };
  }

  // Start, switch, drain ----------------------------------------------------------

  /** Boots generation 1 from the kernel's resolved catalog. */
  async boot(resolved: ResolvedEnvironment): Promise<void> {
    this.#kernelSignature = kernelSignature(resolved);
    this.#counter = resolved.generation;

    const outcome = await this.#start(resolved, 1);

    if (outcome.live !== undefined) {
      this.#activate(outcome.live, 'boot');
    } else {
      this.#activateFailed(outcome.failed as Live, 'boot');
    }
  }

  async publish(): Promise<PublishResult> {
    this.#publishing ??= this.#publish().finally(() => {
      this.#publishing = undefined;
    });

    return await this.#publishing;
  }

  async #publish(): Promise<PublishResult> {
    if (this.#stopping !== undefined) {
      return { status: 'failed', reason: 'The host is stopping.' };
    }

    const generation = this.#counter + 1;
    const resolved = await this.#deps.readCatalog(generation);

    if (kernelSignature(resolved) !== this.#kernelSignature) {
      return {
        status: 'kernel_restart_required',
        reason:
          'The kernel partition (foundation, core or embedded bundles, or the providers they publish) changed; restart the host.',
      };
    }

    this.#counter = generation;

    const outcome = await this.#start(resolved, 1);

    if (outcome.live === undefined) {
      const reason = (outcome.failed as Live).failure as string;

      this.#deps.kernelDiagnostics.report({
        bundleId: this.#deps.platform.bundleId,
        kind: 'generation_failed',
        message: reason,
        details: { generation },
      });
      (outcome.failed as Live).state = 'failed';

      return { status: 'failed', reason };
    }

    this.#activate(outcome.live, 'publish');

    return { status: 'published', generation };
  }

  /** Starts a generation, up to `startAttempts` processes. */
  async #start(
    resolved: ResolvedEnvironment,
    firstIncarnation: number,
  ): Promise<{ live?: Live; failed?: Live }> {
    const partition = partitionCatalog(resolved);
    const live: Live = {
      generation: resolved.generation,
      incarnation: firstIncarnation,
      state: 'starting',
      resolved: partition.published,
      generationOrder: partition.generationOrder,
      generationEntries: partition.generationEntries,
      records: new ServiceDirectory(),
      view: new LayeredDirectory(this.#deps.kernelDirectory),
      controller: new AbortController(),
      holds: new Map(),
      stopping: false,
    };

    this.#lives.set(live.generation, live);
    this.#latest ??= live;

    return await this.#attempts(live, firstIncarnation);
  }

  async #attempts(
    live: Live,
    firstIncarnation: number,
  ): Promise<{ live?: Live; failed?: Live }> {
    const exits: string[] = [];

    for (let attempt = 0; attempt < this.#deps.startAttempts; attempt += 1) {
      if (this.#stopping !== undefined) {
        break;
      }

      live.incarnation = firstIncarnation + attempt;

      const reason = await this.#launch(live);

      if (reason === undefined) {
        return { live };
      }

      exits.push(describeExit(reason));
    }

    live.failure = `Generation ${live.generation} could not start: its process exited before it was ready (${exits.join('; ') || 'stopped'}).`;

    return { failed: live };
  }

  /** One process of a generation; resolves undefined once it is ready. */
  #launch(live: Live): Promise<LinkCloseReason | undefined> {
    const deps = this.#deps;
    const records = new ServiceDirectory();
    const controller = new AbortController();

    live.state = 'starting';
    live.records = records;
    live.view = new LayeredDirectory(deps.kernelDirectory, records);
    live.controller = controller;
    live.child = undefined;
    live.stopping = false;
    live.ready = false;

    const kernelEntries = new Set(deps.kernelActive);
    const kernelProviders = deps.kernelProviders();

    live.announced = new Map(
      kernelProviders.map((descriptor) => [
        providerKey(descriptor),
        JSON.stringify(descriptor),
      ]),
    );

    const init: GenerationInit = {
      environment: deps.environment,
      generation: live.generation,
      incarnation: live.incarnation,
      platformVersion: PLATFORM_VERSION,
      composition: live.resolved.composition,
      entries: live.generationEntries,
      order: live.generationOrder,
      contracts: live.resolved.contracts,
      preActive: [...kernelEntries],
      kernelProviders,
      hooksProvider: 'remote',
      catalog: this.catalogOf(live, live.resolved),
    };

    let spawned: SpawnedGeneration;

    try {
      spawned = deps.spawn(init);
    } catch (error) {
      deps.kernelDiagnostics.report({
        bundleId: deps.platform.bundleId,
        kind: 'generation_failed',
        message: messageOf(error),
        details: { generation: live.generation },
      });

      return Promise.resolve({ kind: 'exited', code: null, signal: null });
    }

    live.spawned = spawned;

    const link = new ProcessLink({
      transport: spawned.transport,
      side: 'kernel',
      generation: live.generation,
      incarnation: live.incarnation,
      validators: deps.validators,
      errors: deps.errors,
      resolve: ({ contract, ...target }) =>
        deps.kernelDirectory
          .providers(contract)
          .find((record: ProviderRecord) => matchesTarget(record, target)),
      principalOf: deps.principalOf,
      report: (entry) => deps.kernelDiagnostics.report(entry),
      generationSignal: controller.signal,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    live.link = link;

    const withdraw = new Map<string, () => void>();
    let exited: () => void = () => undefined;

    live.exited = new Promise<void>((resolve) => {
      exited = resolve;
    });

    return new Promise<LinkCloseReason | undefined>((resolve) => {
      let ready = false;

      // First listener: runs before the link rejects its pending calls.
      link.onClose((reason) => {
        controller.abort();
        withdraw.clear();
        exited();

        if (!ready) {
          live.state = 'stopped';
          resolve(reason);

          return;
        }

        this.#closed(live, reason);
      });
      link.onIdle(() => this.#maybeStop(live));
      link.onControl((message: ControlMessage) => {
        switch (message.kind) {
          case 'ready':
            ready = true;
            live.ready = true;
            // Kernel providers registered while it started.
            this.#syncKernelProviders(live);
            resolve(undefined);

            return;
          case 'provide': {
            const { descriptor } = message;
            const key = announcedKey(descriptor);

            try {
              withdraw.get(key)?.();
              withdraw.set(key, registerRemote(link, records, descriptor));
            } catch (error) {
              deps.kernelDiagnostics.report({
                bundleId: descriptor.bundleId,
                kind: 'registration_failed',
                message: messageOf(error),
                details: { contract: descriptor.contractId },
              });
            }

            return;
          }
          case 'unprovide': {
            const key = announcedKey(message);

            withdraw.get(key)?.();
            withdraw.delete(key);

            return;
          }
          case 'diagnostics':
            live.child = message.snapshot;

            return;
          case 'platform-log':
            deps.log[message.level](message.fields, message.message);

            return;
          default:
            return;
        }
      });

      try {
        link.sendControl({ kind: 'init', init });
      } catch {
        // The process already exited: its close resolves this attempt.
      }
    });
  }

  #activate(live: Live, why: 'boot' | 'publish' | 'respawn'): void {
    const previous = this.#active;
    const replaced = previous !== undefined && previous !== live;

    live.state = 'active';
    live.failure = undefined;
    this.#active = live;
    this.#latest = live;

    if (replaced) {
      previous.state = previous.state === 'failed' ? 'stopped' : 'draining';
    }

    // A draining generation's providers stay active for the subscribers that
    // hold them (the transport's watch, G-1) until that generation stops.
    this.#deps.activeView.setOverlay(live.records, {
      retain: replaced && previous.state === 'draining',
    });
    this.#pushCatalogs();
    // Listeners run before the drain check, so a call they start on the
    // draining generation (runtime/v1.drain) keeps it alive.
    this.#announceActive(live.generation);

    if (replaced) {
      this.#maybeStop(previous);
    }

    if (why !== 'boot') {
      void this.#generationReady(live.generation);
    }
  }

  /** Start attempts exhausted with no other active generation: an empty view. */
  #activateFailed(live: Live, why: 'boot' | 'respawn'): void {
    live.state = 'failed';
    live.records = new ServiceDirectory();
    live.view = new LayeredDirectory(this.#deps.kernelDirectory, live.records);
    this.#active = live;
    this.#latest = live;
    this.#deps.activeView.setOverlay(live.records);
    this.#deps.kernelDiagnostics.report({
      bundleId: this.#deps.platform.bundleId,
      kind: 'generation_failed',
      message: live.failure as string,
      details: { generation: live.generation },
    });

    for (const entry of live.generationEntries) {
      this.#deps.log.warn(
        {
          bundleId: entry.id,
          reasons: [
            ...entry.reasons,
            { code: 'generation_failed', message: live.failure },
          ],
        },
        'Bundle quarantined',
      );
    }

    void why;
    this.#announceActive(live.generation);
  }

  #announceActive(generation: number): void {
    for (const wake of [...this.#waiting]) {
      wake();
    }

    for (const listener of [...this.#activeListeners]) {
      try {
        listener(generation);
      } catch (error) {
        this.#deps.kernelDiagnostics.report({
          bundleId: this.#deps.platform.bundleId,
          kind: 'generation_listener_failed',
          message: messageOf(error),
        });
      }
    }
  }

  async #generationReady(generation: number): Promise<void> {
    const hooks = this.#deps.appHooks();

    if (hooks === undefined) {
      return;
    }

    try {
      await hooks.onGenerationReadyHook.execute(
        { generation },
        this.#deps.platformCall(generation),
      );
    } catch (error) {
      this.#deps.kernelDiagnostics.report({
        bundleId: this.#deps.platform.bundleId,
        kind: 'hook_execute_failed',
        message: messageOf(error),
        details: { hook: 'onGenerationReadyHook', generation },
      });
    }
  }

  /** An unexpected exit of a ready generation process. */
  #closed(live: Live, reason: LinkCloseReason): void {
    if (live.stopping || this.#stopping !== undefined) {
      live.state = 'stopped';

      return;
    }

    const wasActive = this.#active === live;
    const executions = [...live.holds.values()].filter(isExecution);

    live.holds.clear();

    const lost: LostGeneration = {
      generation: live.generation,
      incarnation: live.incarnation,
      executions,
    };

    for (const listener of [...this.#lost]) {
      try {
        listener(lost);
      } catch (error) {
        this.#deps.kernelDiagnostics.report({
          bundleId: this.#deps.platform.bundleId,
          kind: 'generation_listener_failed',
          message: messageOf(error),
        });
      }
    }

    this.#deps.kernelDiagnostics.report({
      bundleId: this.#deps.platform.bundleId,
      kind: 'generation_lost',
      message: `Generation ${live.generation} (incarnation ${live.incarnation}) exited (${describeExit(reason)}).`,
      details: { generation: live.generation, incarnation: live.incarnation },
    });

    if (!wasActive) {
      live.state = 'stopped';
      this.#deps.activeView.release(live.records);

      return;
    }

    live.state = 'starting';
    this.#active = undefined;
    this.#deps.activeView.setOverlay(undefined);
    queueMicrotask(() => {
      void this.#respawn(live);
    });
  }

  async #respawn(live: Live): Promise<void> {
    const outcome = await this.#attempts(live, live.incarnation + 1);

    if (this.#stopping !== undefined) {
      return;
    }

    if (outcome.live !== undefined) {
      this.#activate(outcome.live, 'respawn');
    } else if (this.#active === undefined) {
      this.#activateFailed(live, 'respawn');
    } else {
      live.state = 'stopped';
    }
  }

  #maybeStop(live: Live): void {
    if (
      live.state === 'draining' &&
      live.holds.size === 0 &&
      (live.link === undefined || live.link.inFlight === 0)
    ) {
      void this.#stopLive(live);
    }
  }

  async #stopLive(live: Live): Promise<void> {
    if (live.stopping) {
      await live.exited;

      return;
    }

    live.stopping = true;

    const { link, spawned } = live;

    if (link === undefined || link.closeReason !== undefined) {
      live.state = live.state === 'failed' ? 'failed' : 'stopped';
      this.#deps.activeView.release(live.records);

      return;
    }

    try {
      link.sendControl({ kind: 'stop' });
    } catch {
      // Already closed.
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = live.exited ?? Promise.resolve();

    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          spawned?.kill('SIGKILL');
          resolve();
        }, this.#deps.stopTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    await exited;
    live.state = 'stopped';
    this.#deps.activeView.release(live.records);
  }

  stop(): Promise<void> {
    this.#stopping ??= (async () => {
      for (const wake of [...this.#waiting]) {
        wake();
      }

      await Promise.all(
        [...this.#lives.values()].map((live) =>
          live.state === 'stopped' ? undefined : this.#stopLive(live),
        ),
      );

      this.#active = undefined;
      this.#deps.activeView.setOverlay(undefined);
    })();

    return this.#stopping;
  }
}
