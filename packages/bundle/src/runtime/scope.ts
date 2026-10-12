import type { Cleanup, Disposable } from '../contracts/context.js';

/** Receives each failure of a disposal; disposal itself never throws. */
export type DisposalErrorHandler = (error: unknown) => void;

/** An idempotent Disposable over a function. */
export const toDisposable = (dispose: () => void): Disposable => {
  let disposed = false;

  return Object.freeze({
    dispose: () => {
      if (disposed) {
        return;
      }

      disposed = true;
      dispose();
    },
  });
};

export const inertDisposable: Disposable = Object.freeze({
  dispose: () => undefined,
});

type Entry =
  | { readonly kind: 'disposable'; readonly value: Disposable }
  | { readonly kind: 'cleanup'; readonly value: Cleanup }
  | { readonly kind: 'scope'; readonly value: DisposalScope };

/**
 * Tracks registrations and cleanups; disposes them in reverse order. A scope
 * that is already disposed disposes anything tracked afterwards right away.
 */
export class DisposalScope {
  readonly #entries: Entry[] = [];
  readonly #onError: DisposalErrorHandler;
  #disposed = false;
  #disposing: Promise<void> | undefined;

  constructor(onError: DisposalErrorHandler = () => undefined) {
    this.#onError = onError;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  track(disposable: Disposable): void {
    if (this.#disposed) {
      this.#run({ kind: 'disposable', value: disposable }).catch(this.#onError);

      return;
    }

    this.#entries.push({ kind: 'disposable', value: disposable });
  }

  onDispose(cleanup: Cleanup): void {
    if (this.#disposed) {
      this.#run({ kind: 'cleanup', value: cleanup }).catch(this.#onError);

      return;
    }

    this.#entries.push({ kind: 'cleanup', value: cleanup });
  }

  child(): DisposalScope {
    const child = new DisposalScope(this.#onError);

    if (this.#disposed) {
      child.#disposed = true;

      return child;
    }

    this.#entries.push({ kind: 'scope', value: child });

    return child;
  }

  async #run(entry: Entry): Promise<void> {
    try {
      switch (entry.kind) {
        case 'disposable': {
          const registration: Disposable = entry.value;

          registration.dispose();
          break;
        }
        case 'cleanup':
          await entry.value();
          break;
        case 'scope':
          await entry.value.dispose();
          break;
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  /** Disposes tracked entries in reverse order; idempotent. */
  dispose(): Promise<void> {
    if (this.#disposing !== undefined) {
      return this.#disposing;
    }

    this.#disposed = true;
    this.#disposing = (async () => {
      while (this.#entries.length > 0) {
        const entry = this.#entries.pop() as Entry;

        await this.#run(entry);
      }
    })();

    return this.#disposing;
  }
}
