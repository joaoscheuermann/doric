// App events as `doric.app.hooks/v1` hooks of the active generation
// (section 10.2): activate with no window, the quit decision (section 17.3)
// and deduplicated connection transitions.

import { messageOf, type PlatformLog } from './log';

export interface LifecycleTarget {
  /** Runs a hook in the active generation; undefined when there is none. */
  run(
    hook:
      | 'onAppReadyHook'
      | 'onAppActivateHook'
      | 'onBeforeQuitHook'
      | 'onConnectionChangedHook',
    input: unknown,
  ): Promise<unknown>;
}

export interface QuitEvent {
  preventDefault(): void;
}

const isDecision = (
  value: unknown,
): value is { allow: true } | { allow: false; reason: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { allow?: unknown }).allow === 'boolean';

export class Lifecycle {
  readonly #target: LifecycleTarget;
  readonly #log: PlatformLog;
  readonly #quit: () => void;
  readonly #flush: () => Promise<void>;
  #quitting = false;
  #quitDecided = false;
  #connected: boolean | undefined;

  constructor(input: {
    readonly target: LifecycleTarget;
    readonly log: PlatformLog;
    /** `app.quit()`. */
    readonly quit: () => void;
    /** Persists native window paths and state before the process may exit. */
    readonly flush: () => Promise<void>;
  }) {
    this.#target = input.target;
    this.#log = input.log;
    this.#quit = input.quit;
    this.#flush = input.flush;
  }

  /** True while a quit is being decided or carried out: closes are forced. */
  get quitting(): boolean {
    return this.#quitting || this.#quitDecided;
  }

  #failed(hook: string, error: unknown): void {
    this.#log.error({ hook, error: messageOf(error) }, 'App hook failed');
  }

  async appActivate(): Promise<void> {
    try {
      await this.#target.run('onAppActivateHook', {});
    } catch (error) {
      this.#failed('onAppActivateHook', error);
    }
  }

  /**
   * `before-quit`: held until `onBeforeQuitHook` decides (no handler allows);
   * a second quit request while it waits forces the quit.
   */
  beforeQuit(event: QuitEvent): void {
    if (this.#quitDecided) {
      return;
    }

    event.preventDefault();

    if (this.#quitting) {
      this.#quitDecided = true;
      this.#quit();

      return;
    }

    this.#quitting = true;
    void this.#target
      .run('onBeforeQuitHook', {})
      .then(
        (decision) =>
          isDecision(decision) ? decision : { allow: true as const },
        (error: unknown) => {
          this.#failed('onBeforeQuitHook', error);

          return { allow: true as const };
        },
      )
      .then(async (decision) => {
        if (this.#quitDecided) {
          return;
        }

        if (decision.allow) {
          try {
            await this.#flush();
          } catch (error) {
            this.#log.error(
              { error: messageOf(error) },
              'Desktop state could not be saved before quit',
            );
          }

          if (this.#quitDecided) {
            return;
          }

          this.#quitDecided = true;
          this.#quit();

          return;
        }

        this.#quitting = false;
        this.#log.info({ reason: decision.reason }, 'Quit denied');
      });
  }

  /** A connection status change; repeated values are dropped. */
  connectionChanged(connected: boolean): void {
    if (this.#connected === connected) {
      return;
    }

    this.#connected = connected;
    void this.#target
      .run('onConnectionChangedHook', { connected })
      .catch((error: unknown) =>
        this.#failed('onConnectionChangedHook', error),
      );
  }
}
