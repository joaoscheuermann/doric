// The startup sequence behind the splash (section 11.5): connect to the
// host, load and activate a generation, hold the splash for its minimum
// time, fire `onAppReadyHook`, and close the splash at the first window's
// `ready()`; every failure shows its recovery state and waits for an action.

import type { Diagnostics } from 'bundle/contracts';
import type { WindowMode } from 'desktop/protocol';

import { messageOf, type PlatformLog } from '../log';
import {
  type Clock,
  remainingSplashMs,
  sleep,
  WINDOW_READY_DEADLINE_MS,
} from '../splash/timing';
import type { LoadingStep, RecoveryAction, SplashState } from '../splash/state';
import type { DesktopQuarantine } from './resolve';

export type LoadOutcome =
  | {
      readonly kind: 'ready';
      readonly generation: number;
      readonly quarantines: readonly DesktopQuarantine[];
    }
  | {
      readonly kind: 'core-failure';
      readonly core: { readonly id: string; readonly version: string };
      readonly error: string;
    }
  | { readonly kind: 'failed'; readonly error: string };

export interface StartupHost {
  readonly url: string;
  readonly connected: boolean;
  onStatus(
    listener: (status: { connected: boolean; error?: string }) => void,
  ): () => void;
  retry(): void;
}

export interface StartupSplash {
  set(state: SplashState): void;
  /** Opens the splash again (a client core failure after it closed). */
  open(): void;
  close(): void;
}

export interface StartupDeps {
  readonly clock: Clock;
  readonly splash: StartupSplash;
  readonly host: StartupHost;
  readonly log: PlatformLog;
  /** `process.argv.includes('--recovery')`. */
  readonly recovery: boolean;
  readonly hasSnapshot: () => Promise<boolean>;
  readonly hasLastGoodCore: () => boolean;
  /** Loads, verifies, resolves and activates one generation. */
  readonly load: (input: {
    readonly mode: WindowMode;
    readonly step: (step: LoadingStep, progress?: { done: number; total: number }) => void;
  }) => Promise<LoadOutcome>;
  /** Runs `onAppReadyHook` in the active generation. */
  readonly appReady: () => Promise<void>;
  /** HR-6 composition actions on the host. */
  readonly disable: (bundleId: string) => Promise<void>;
  readonly resetComposition: () => Promise<void>;
  readonly diagnostics: () => Diagnostics | undefined;
}

type Waiting = (action: RecoveryAction) => void;

export class Startup {
  readonly #deps: StartupDeps;
  #startedAt = 0;
  #waiting: Waiting | undefined;
  #readyTimer: unknown;
  #appReadyFired = false;
  #firstReady = false;
  /** A window became ready before onAppReadyHook (opened during activation). */
  #earlyReady = false;
  #recovery: boolean;
  #mode: WindowMode = 'connected';
  #state: SplashState = { state: 'loading', step: 'connecting' };

  constructor(deps: StartupDeps) {
    this.#deps = deps;
    this.#recovery = deps.recovery;
  }

  get mode(): WindowMode {
    return this.#mode;
  }

  /** Whether `onAppReadyHook` already ran (activate before it is ignored). */
  get appReadyFired(): boolean {
    return this.#appReadyFired;
  }

  get state(): SplashState {
    return this.#state;
  }

  #set(state: SplashState): void {
    this.#state = state;
    this.#deps.splash.set(state);
  }

  /** An action from the splash page. */
  async act(action: RecoveryAction): Promise<void> {
    if (action.action === 'retry' && this.#state.state === 'host-unreachable') {
      this.#deps.host.retry();

      return;
    }

    const waiting = this.#waiting;

    if (waiting === undefined) {
      return;
    }

    this.#waiting = undefined;
    waiting(action);
  }

  #nextAction(): Promise<RecoveryAction> {
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  /** Waits until the bridge connects, or the user opens the last snapshot. */
  async #connect(): Promise<'connected' | 'open-last-known'> {
    const { host } = this.#deps;

    if (host.connected) {
      return 'connected';
    }

    const hasSnapshot = await this.#deps.hasSnapshot();
    let attempts = 0;

    return await new Promise((resolve) => {
      let done = false;
      const finish = (value: 'connected' | 'open-last-known') => {
        if (!done) {
          done = true;
          off();
          this.#waiting = undefined;
          resolve(value);
        }
      };
      const off = host.onStatus((status) => {
        if (status.connected) {
          finish('connected');

          return;
        }

        attempts += 1;
        this.#set({
          state: 'host-unreachable',
          hostUrl: host.url,
          lastError: status.error ?? 'The connection was refused.',
          attempts,
          hasSnapshot,
        });
        const waiting: Waiting = (action) => {
          if (action.action === 'open-last-known' && hasSnapshot) {
            finish('open-last-known');
          } else if (!done) {
            this.#waiting = waiting;
          }
        };

        this.#waiting = waiting;
      });

      if (host.connected) {
        finish('connected');
      }
    });
  }

  /** Runs the startup until `onAppReadyHook` fired. */
  async run(): Promise<void> {
    this.#startedAt = this.#deps.clock.now();
    let mode: WindowMode = 'connected';

    for (;;) {
      this.#set({ state: 'loading', step: 'connecting' });

      if (mode === 'connected') {
        const connected = await this.#connect();

        if (connected === 'open-last-known') {
          mode = 'disconnected-copy';
        }
      }

      const outcome = await this.#load(mode);

      if (outcome.kind === 'failed') {
        this.#set({
          state: 'recovery',
          reason: outcome.error,
          ...this.#diagnosticsField(),
          hasLastGoodCore: this.#deps.hasLastGoodCore(),
        });

        const action = await this.#nextAction();

        mode = await this.#recover(action, mode);
        continue;
      }

      if (outcome.kind === 'core-failure') {
        this.#set({
          state: 'core-failure',
          core: outcome.core,
          error: outcome.error,
          hasLastGoodCore: this.#deps.hasLastGoodCore(),
        });

        const action = await this.#nextAction();

        mode = await this.#recover(action, mode);
        continue;
      }

      if (outcome.quarantines.length > 0) {
        this.#set({ state: 'bundle-failure', bundles: outcome.quarantines });

        const action = await this.#nextAction();

        if (action.action !== 'continue') {
          mode = await this.#recover(action, mode);
          continue;
        }
      }

      if (this.#recovery) {
        this.#set({
          state: 'recovery',
          reason: 'Recovery was requested with --recovery.',
          ...this.#diagnosticsField(),
          hasLastGoodCore: this.#deps.hasLastGoodCore(),
        });

        const action = await this.#nextAction();

        this.#recovery = false;

        if (action.action !== 'retry') {
          mode = await this.#recover(action, mode);
        }

        continue;
      }

      this.#mode = mode;
      break;
    }

    const remaining = remainingSplashMs(
      this.#deps.clock.now() - this.#startedAt,
    );

    if (remaining > 0) {
      await sleep(this.#deps.clock, remaining);
    }

    await this.#fireAppReady();
  }

  #diagnosticsField(): { diagnostics?: Diagnostics } {
    const diagnostics = this.#deps.diagnostics();

    return diagnostics === undefined ? {} : { diagnostics };
  }

  async #fireAppReady(): Promise<void> {
    this.#appReadyFired = true;

    if (this.#earlyReady) {
      this.windowReady();
    } else {
      this.#armReadyDeadline();
    }

    try {
      await this.#deps.appReady();
    } catch (error) {
      this.#deps.log.error(
        { hook: 'onAppReadyHook', error: messageOf(error) },
        'onAppReadyHook failed',
      );
    }
  }

  #armReadyDeadline(): void {
    const { clock } = this.#deps;

    clock.clearTimeout(this.#readyTimer);
    this.#readyTimer = clock.setTimeout(() => {
      this.#readyTimer = undefined;

      if (this.#firstReady) {
        return;
      }

      this.#set({
        state: 'recovery',
        reason: 'No window became ready.',
        ...this.#diagnosticsField(),
        hasLastGoodCore: this.#deps.hasLastGoodCore(),
      });
      void this.#nextAction().then(async (action) => {
        if (action.action === 'retry') {
          this.#set({ state: 'loading', step: 'activation' });
          await this.#fireAppReady();

          return;
        }

        const mode = await this.#recover(action, this.#mode);

        await this.#reload(mode);
      });
    }, WINDOW_READY_DEADLINE_MS);
  }

  async #reload(mode: WindowMode): Promise<void> {
    const outcome = await this.#load(mode);

    if (outcome.kind === 'ready') {
      this.#mode = mode;
      await this.#fireAppReady();

      return;
    }

    this.#set({
      state: outcome.kind === 'core-failure' ? 'core-failure' : 'recovery',
      ...(outcome.kind === 'core-failure'
        ? {
            core: outcome.core,
            error: outcome.error,
            hasLastGoodCore: this.#deps.hasLastGoodCore(),
          }
        : {
            reason: outcome.error,
            hasLastGoodCore: this.#deps.hasLastGoodCore(),
          }),
    } as SplashState);
    const action = await this.#nextAction();

    await this.#reload(await this.#recover(action, mode));
  }

  /** What an action means for the next attempt. */
  async #recover(action: RecoveryAction, mode: WindowMode): Promise<WindowMode> {
    try {
      switch (action.action) {
        case 'use-last-good-core':
          return this.#deps.hasLastGoodCore() ? 'last-good-core' : mode;
        case 'disable':
          await this.#deps.disable(action.bundleId);

          return 'connected';
        case 'reset-composition':
          await this.#deps.resetComposition();

          return 'connected';
        case 'open-last-known':
          return 'disconnected-copy';
        default:
          return mode === 'last-good-core' ? 'connected' : mode;
      }
    } catch (error) {
      this.#deps.log.warn(
        { action: action.action, error: messageOf(error) },
        'Recovery action failed',
      );

      return mode;
    }
  }

  async #load(mode: WindowMode): Promise<LoadOutcome> {
    try {
      return await this.#deps.load({
        mode,
        step: (step, progress) =>
          this.#set({
            state: 'loading',
            step,
            ...(progress === undefined ? {} : { progress }),
          }),
      });
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    }
  }

  /** A window's `ready()`: the first one closes the splash. */
  windowReady(): void {
    if (!this.#appReadyFired) {
      this.#earlyReady = true;

      return;
    }

    if (this.#firstReady) {
      return;
    }

    this.#firstReady = true;
    this.#deps.clock.clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
    this.#deps.splash.close();
  }

  /** The workspace window's client core failed: the splash opens again. */
  coreFailed(core: { id: string; version: string }, error: string): void {
    this.#deps.splash.open();
    this.#set({
      state: 'core-failure',
      core,
      error,
      hasLastGoodCore: this.#deps.hasLastGoodCore(),
    });
    void this.#nextAction().then(async (action) => {
      await this.#reload(await this.#recover(action, this.#mode));
    });
  }
}
