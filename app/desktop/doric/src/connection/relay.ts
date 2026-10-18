import type { ConnectionListener, ConnectionStatus } from './status';

/** The `/status` monitor as the window platform reads it. */
export interface ConnectionSource {
  status(): ConnectionStatus;
  subscribe(listener: ConnectionListener): () => void;
}

/**
 * The host connection status every window's `doric.shell/v1.connection`
 * stream follows (stage 9, D9-5). It reads `disconnected` until main attaches
 * the `/status` monitor, and its listeners hear only changes.
 */
export class ConnectionRelay implements ConnectionSource {
  #current: ConnectionStatus = 'disconnected';
  #detach: (() => void) | undefined;
  readonly #listeners = new Set<ConnectionListener>();

  status(): ConnectionStatus {
    return this.#current;
  }

  subscribe(listener: ConnectionListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Follows `source` from now on (replacing an earlier one). */
  attach(source: ConnectionSource): void {
    this.#detach?.();
    this.#detach = source.subscribe((status) => this.#publish(status));
    this.#publish(source.status());
  }

  #publish(status: ConnectionStatus): void {
    if (status === this.#current) {
      return;
    }

    this.#current = status;

    for (const listener of [...this.#listeners]) {
      listener(status);
    }
  }
}
