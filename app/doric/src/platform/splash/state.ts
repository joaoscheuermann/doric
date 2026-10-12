// Main's side of the splash: the action schema `act` is validated with and
// the state holder the `state` stream reads.

import { z } from 'zod';

import type { RecoveryAction, SplashState } from './protocol';

export {
  type LoadingStep,
  loadingText,
  type RecoveryAction,
  SPLASH_CONTRACT,
  type SplashState,
} from './protocol';

export const recoveryActionSchema: z.ZodType<RecoveryAction> = z.union([
  z.object({ action: z.literal('retry') }).strict(),
  z.object({ action: z.literal('open-last-known') }).strict(),
  z.object({ action: z.literal('continue') }).strict(),
  z.object({ action: z.literal('disable'), bundleId: z.string() }).strict(),
  z.object({ action: z.literal('use-last-good-core') }).strict(),
  z.object({ action: z.literal('reset-composition') }).strict(),
]);

/** Holds the current state and tells the splash page every change. */
export class SplashStates {
  #state: SplashState = { state: 'loading', step: 'connecting' };
  readonly #listeners = new Set<(state: SplashState) => void>();

  get current(): SplashState {
    return this.#state;
  }

  set(state: SplashState): void {
    this.#state = state;

    for (const listener of [...this.#listeners]) {
      listener(state);
    }
  }

  /** The current state first, then every change. */
  subscribe(listener: (state: SplashState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);

    return () => this.#listeners.delete(listener);
  }
}
