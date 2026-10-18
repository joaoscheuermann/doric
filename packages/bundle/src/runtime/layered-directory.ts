import type {
  Directory,
  ProviderListener,
  ProviderRecord,
} from './directory.js';

interface Subscription {
  readonly contractId: string;
  readonly listener: ProviderListener;
  active: boolean;
  unsubscribeOverlay: () => void;
  /** Subscriptions to retained overlays, which only forward removals. */
  readonly retained: Map<Directory, () => void>;
}

const noop = () => {};

/**
 * A directory read over a base layer and a switchable overlay. Registrations
 * go to the base; reads return base records before overlay records; switching
 * the overlay tells every subscriber the old overlay records were removed and
 * the new ones were added.
 *
 * A switch may instead retain the old overlay (a draining generation): its
 * records are no longer read, but they stay active for the subscribers that
 * already hold them, and their removal reaches those subscribers only when the
 * overlay removes them itself or is released.
 */
export class LayeredDirectory implements Directory {
  readonly base: Directory;
  #overlay: Directory | undefined;
  readonly #retained = new Set<Directory>();
  readonly #subscriptions = new Set<Subscription>();

  constructor(base: Directory, overlay?: Directory) {
    this.base = base;
    this.#overlay = overlay;
  }

  /** The current overlay; undefined while no overlay is set. */
  get overlay(): Directory | undefined {
    return this.#overlay;
  }

  /**
   * Replaces the overlay and notifies subscribers of the change. With
   * `retain`, the previous overlay is kept until `release` (see the class).
   */
  setOverlay(
    next: Directory | undefined,
    options: { readonly retain?: boolean } = {},
  ): void {
    const previous = this.#overlay;

    if (previous === next) {
      return;
    }

    this.#overlay = next;

    if (next !== undefined && this.#retained.has(next)) {
      this.release(next);
    }

    const keep = options.retain === true && previous !== undefined;

    if (keep) {
      this.#retained.add(previous);
    }

    for (const subscription of [...this.#subscriptions]) {
      if (keep) {
        subscription.retained.set(previous, subscription.unsubscribeOverlay);
        subscription.unsubscribeOverlay = noop;
      } else {
        subscription.unsubscribeOverlay();
        subscription.unsubscribeOverlay = noop;

        for (const record of previous?.providers(subscription.contractId) ??
          []) {
          if (!subscription.active) {
            break;
          }

          subscription.listener.removed(record);
        }
      }

      if (subscription.active) {
        subscription.unsubscribeOverlay = this.#subscribeOverlay(subscription);
      }
    }
  }

  /** Ends a retained overlay: its remaining records are removed for subscribers. */
  release(overlay: Directory): void {
    if (!this.#retained.delete(overlay)) {
      return;
    }

    for (const subscription of [...this.#subscriptions]) {
      const unsubscribe = subscription.retained.get(overlay);

      if (unsubscribe === undefined) {
        continue;
      }

      subscription.retained.delete(overlay);
      unsubscribe();

      for (const record of overlay.providers(subscription.contractId)) {
        if (!subscription.active) {
          break;
        }

        subscription.listener.removed(record);
      }
    }
  }

  register(record: ProviderRecord): () => void {
    return this.base.register(record);
  }

  providers(contractId: string): readonly ProviderRecord[] {
    const base = this.base.providers(contractId);
    const overlay = this.#overlay?.providers(contractId) ?? [];

    return overlay.length === 0
      ? base
      : base.length === 0
        ? overlay
        : [...base, ...overlay];
  }

  active(contractId: string): ProviderRecord | undefined {
    return this.base.active(contractId) ?? this.#overlay?.active(contractId);
  }

  isActive(record: ProviderRecord): boolean {
    if (
      this.base.isActive(record) ||
      (this.#overlay?.isActive(record) ?? false)
    ) {
      return true;
    }

    for (const retained of this.#retained) {
      if (retained.isActive(record)) {
        return true;
      }
    }

    return false;
  }

  subscribe(contractId: string, listener: ProviderListener): () => void {
    const subscription: Subscription = {
      contractId,
      listener,
      active: true,
      unsubscribeOverlay: noop,
      retained: new Map(),
    };

    this.#subscriptions.add(subscription);

    const forward: ProviderListener = {
      added: (record) => {
        if (subscription.active) {
          listener.added(record);
        }
      },
      removed: (record) => {
        if (subscription.active) {
          listener.removed(record);
        }
      },
    };
    const unsubscribeBase = this.base.subscribe(contractId, forward);

    if (subscription.active) {
      subscription.unsubscribeOverlay = this.#subscribeOverlay(subscription);
    }

    return () => {
      subscription.active = false;
      this.#subscriptions.delete(subscription);
      unsubscribeBase();
      subscription.unsubscribeOverlay();
      subscription.unsubscribeOverlay = noop;

      for (const unsubscribe of subscription.retained.values()) {
        unsubscribe();
      }

      subscription.retained.clear();
    };
  }

  #subscribeOverlay(subscription: Subscription): () => void {
    const overlay = this.#overlay;

    if (overlay === undefined) {
      return noop;
    }

    return overlay.subscribe(subscription.contractId, {
      added: (record) => {
        if (subscription.active && this.#overlay === overlay) {
          subscription.listener.added(record);
        }
      },
      removed: (record) => {
        if (
          subscription.active &&
          (this.#overlay === overlay || subscription.retained.has(overlay))
        ) {
          subscription.listener.removed(record);
        }
      },
    });
  }
}
