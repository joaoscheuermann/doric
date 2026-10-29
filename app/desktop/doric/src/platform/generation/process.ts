// One desktopMain generation in a utility process (section 13.1). Main plays
// the kernel role: it sends `init` with its platform providers
// (`doric.windows|menus|cache|migrations|tokens|notifications|log/v1`), keeps the
// providers the generation announces in a directory of its own, and runs the
// app lifecycle hooks through the generation's `hooks/v1`.

import {
  AppHooksV1,
  type CatalogSnapshot,
  type Diagnostics,
  type Services,
} from 'bundle/contracts';
import {
  announcedKey,
  type ControlMessage,
  catalogView,
  createErrorClassRegistry,
  createHopCall,
  createPrincipal,
  describeRecord,
  dispatch,
  type GenerationInit,
  type LinkCloseReason,
  matchesTarget,
  PLATFORM_VERSION,
  type Principal,
  ProcessLink,
  type ProviderRecord,
  type RemoteProviderDescriptor,
  type ResolvedEnvironment,
  registerRemote,
  type SchemaValidators,
  ServiceDirectory,
  type Transport,
} from 'bundle/runtime';

import { messageOf, type PlatformLog } from '../log';

/** The platform providers main answers in every desktopMain generation. */
export const KERNEL_CONTRACTS = [
  'doric.windows/v1',
  'doric.menus/v1',
  'doric.cache/v1',
  'doric.migrations/v1',
  'doric.tokens/v1',
  'doric.notifications/v1',
  'doric.log/v1',
  'doric.drawio/v1',
] as const;

export interface SpawnedRunner {
  readonly transport: Transport;
  kill(): void;
}

export interface GenerationProcessOptions {
  readonly generation: number;
  /** The desktopMain environment main resolved for this generation. */
  readonly resolved: ResolvedEnvironment;
  readonly catalog: CatalogSnapshot;
  /** Main's directory holding its platform providers. */
  readonly kernel: ServiceDirectory;
  readonly kernelPrincipal: Principal;
  readonly validators: SchemaValidators;
  readonly log: PlatformLog;
  readonly spawn: (incarnation: number) => SpawnedRunner;
  /** A bundle's state changed in the pushed diagnostics (menus drop its items). */
  readonly diagnostics?: (snapshot: Diagnostics) => void;
  /** The process exited after it was ready (before a respawn). */
  readonly lost?: (reason: LinkCloseReason) => void;
  /** Respawned after a loss; `onAppReadyHook` is not fired again. */
  readonly respawned?: () => void;
  readonly now?: () => number;
}

export interface Activation {
  readonly ok: boolean;
  /** The runner's diagnostics after activation. */
  readonly diagnostics: Diagnostics | undefined;
  /** Why the process did not become ready. */
  readonly error?: string;
}

export const describeExit = (reason: LinkCloseReason): string =>
  reason.kind === 'exited'
    ? `exited with code ${reason.code === null ? 'null' : reason.code}${reason.signal === null ? '' : `, signal ${reason.signal}`}`
    : reason.kind;

/** The order of the init's activation (desktopMain: every scheduled entry). */
const initOf = (
  options: GenerationProcessOptions,
  incarnation: number,
): GenerationInit => {
  const kernelProviders: RemoteProviderDescriptor[] = [];

  for (const id of KERNEL_CONTRACTS) {
    for (const record of options.kernel.providers(id)) {
      kernelProviders.push(describeRecord(record));
    }
  }

  return {
    environment: 'desktopMain',
    generation: options.generation,
    incarnation,
    platformVersion: PLATFORM_VERSION,
    composition: options.resolved.composition,
    entries: options.resolved.entries,
    order: options.resolved.order,
    contracts: options.resolved.contracts,
    preActive: [],
    kernelProviders,
    hooksProvider: 'local',
    catalog: options.catalog,
  };
};

export class GenerationProcess {
  readonly generation: number;
  readonly #options: GenerationProcessOptions;
  #records = new ServiceDirectory();
  #link: ProcessLink | undefined;
  #spawned: SpawnedRunner | undefined;
  #principal: Principal;
  #controller = new AbortController();
  #diagnostics: Diagnostics | undefined;
  #incarnation = 0;
  #stopping: Promise<void> | undefined;
  #exited: Promise<void> = Promise.resolve();
  #ready = false;
  #respawns = 0;
  readonly #exitListeners = new Set<(reason: LinkCloseReason) => void>();

  constructor(options: GenerationProcessOptions) {
    this.generation = options.generation;
    this.#options = options;
    this.#principal = this.#principalOver(this.#records);
  }

  #principalOver(records: ServiceDirectory): Principal {
    return createPrincipal(
      {
        directory: records,
        catalog: catalogView(this.#options.resolved),
        environment: 'desktopMain',
        generation: this.generation,
        operationGeneration: this.generation,
        generationSignal: this.#controller.signal,
        report: () => undefined,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      },
      {
        bundleId: 'doric',
        version: PLATFORM_VERSION,
        provides: 'any',
        requires: 'any',
      },
    );
  }

  /** The providers the generation announced. */
  get records(): ServiceDirectory {
    return this.#records;
  }

  /** Main's `doric` principal over this generation's providers. */
  get services(): Services {
    return this.#principal.services;
  }

  get diagnostics(): Diagnostics | undefined {
    return this.#diagnostics;
  }

  get alive(): boolean {
    return this.#link !== undefined && this.#link.closeReason === undefined;
  }

  onExit(listener: (reason: LinkCloseReason) => void): () => void {
    this.#exitListeners.add(listener);

    return () => this.#exitListeners.delete(listener);
  }

  /** A platform call of main pinned to this generation. */
  call(input: { readonly windowKey?: string } = {}) {
    return createHopCall({
      caller: this.#principal.caller,
      generation: this.generation,
      generationSignal: this.#controller.signal,
      ...(input.windowKey === undefined ? {} : { windowKey: input.windowKey }),
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    });
  }

  /** Spawns the process and activates the generation's desktopMain parts. */
  start(): Promise<Activation> {
    this.#incarnation += 1;

    const options = this.#options;
    const incarnation = this.#incarnation;
    const records = new ServiceDirectory();
    let spawned: SpawnedRunner;

    this.#records = records;
    this.#principal = this.#principalOver(records);

    try {
      spawned = options.spawn(incarnation);
    } catch (error) {
      return Promise.resolve({
        ok: false,
        diagnostics: undefined,
        error: messageOf(error),
      });
    }

    this.#spawned = spawned;

    const link = new ProcessLink({
      transport: spawned.transport,
      side: 'kernel',
      generation: this.generation,
      incarnation,
      validators: options.validators,
      errors: createErrorClassRegistry(),
      resolve: ({ contract, ...target }) =>
        options.kernel
          .providers(contract)
          .find((record: ProviderRecord) => matchesTarget(record, target)),
      principalOf: (bundleId) =>
        bundleId === options.kernelPrincipal.bundleId
          ? options.kernelPrincipal
          : undefined,
      report: (entry) =>
        options.log.warn(
          { generation: this.generation, ...entry },
          'Generation report',
        ),
      generationSignal: this.#controller.signal,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    this.#link = link;

    const withdraw = new Map<string, () => void>();
    let exited: () => void = () => undefined;

    this.#exited = new Promise<void>((resolve) => {
      exited = resolve;
    });

    return new Promise<Activation>((resolve) => {
      link.onClose((reason) => {
        withdraw.clear();
        exited();

        if (!this.#ready) {
          resolve({
            ok: false,
            diagnostics: this.#diagnostics,
            error: `The desktopMain process ${describeExit(reason)} before it was ready.`,
          });

          return;
        }

        this.#closed(reason);
      });
      link.onControl((message: ControlMessage) => {
        switch (message.kind) {
          case 'ready':
            this.#ready = true;
            resolve({
              ok: this.#diagnostics?.mode !== 'recovery',
              diagnostics: this.#diagnostics,
              ...(this.#diagnostics?.mode === 'recovery'
                ? {
                    error:
                      this.#diagnostics.recovery?.reason ??
                      'The core desktopMain part failed.',
                  }
                : {}),
            });

            return;
          case 'provide': {
            const key = announcedKey(message.descriptor);

            try {
              withdraw.get(key)?.();
              withdraw.set(
                key,
                registerRemote(link, records, message.descriptor),
              );
            } catch (error) {
              options.log.warn(
                {
                  generation: this.generation,
                  bundleId: message.descriptor.bundleId,
                  contract: message.descriptor.contractId,
                  error: messageOf(error),
                },
                'Generation provider refused',
              );
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
            this.#diagnostics = message.snapshot;
            options.diagnostics?.(message.snapshot);

            return;
          case 'platform-log':
            options.log[message.level](
              { generation: this.generation, ...message.fields },
              message.message,
            );

            return;
          default:
            return;
        }
      });

      try {
        link.sendControl({ kind: 'init', init: initOf(options, incarnation) });
      } catch {
        // The process already exited: its close resolves this start.
      }
    });
  }

  /** A loss after ready: one respawn and re-activation (section 13.1). */
  #closed(reason: LinkCloseReason): void {
    this.#ready = false;

    for (const listener of [...this.#exitListeners]) {
      listener(reason);
    }

    if (this.#stopping !== undefined) {
      return;
    }

    this.#options.log.error(
      { generation: this.generation, exit: describeExit(reason) },
      'The desktopMain process exited',
    );
    this.#options.lost?.(reason);

    if (this.#respawns >= 1) {
      return;
    }

    this.#respawns += 1;
    void this.start().then((activation) => {
      if (activation.ok) {
        this.#options.respawned?.();
      } else {
        this.#options.log.error(
          { generation: this.generation, error: activation.error },
          'The desktopMain process could not be respawned',
        );
      }
    });
  }

  /**
   * Runs one app lifecycle hook through the generation's `hooks/v1` (main's
   * caller is `doric`, the owner of AppHooksV1). No provider: a decision
   * hook allows, the others do nothing.
   */
  async lifecycle(
    hook:
      | 'onAppReadyHook'
      | 'onAppActivateHook'
      | 'onBeforeQuitHook'
      | 'onGenerationReadyHook'
      | 'onConnectionChangedHook',
    input: unknown,
  ): Promise<unknown> {
    const record = this.#records.active('hooks/v1');

    if (record === undefined || !this.alive) {
      return hook === 'onBeforeQuitHook' ? { allow: true } : undefined;
    }

    return await dispatch(
      this.#principal,
      { contractId: 'hooks/v1' },
      'execute',
      [AppHooksV1, hook, input, this.call()],
    );
  }

  /** Reverse deactivation in the process, then its exit (killed after 10 s). */
  stop(timeoutMs = 10_000): Promise<void> {
    this.#stopping ??= (async () => {
      const link = this.#link;

      if (link === undefined || link.closeReason !== undefined) {
        this.#controller.abort();

        return;
      }

      try {
        link.sendControl({ kind: 'stop' });
      } catch {
        // Already closed.
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      await Promise.race([
        this.#exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.#spawned?.kill();
            resolve();
          }, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      this.#controller.abort();
    })();

    return this.#stopping;
  }
}
