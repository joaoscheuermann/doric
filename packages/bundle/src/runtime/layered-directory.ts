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
}

const noop = () => {};

/**
 * A directory read over a base layer and a switchable overlay. Registrations
 * go to the base; reads return base records before overlay records; switching
 * the overlay tells every subscriber the old overlay records were removed and
 * the new ones were added.
 */
export class LayeredDirectory implements Directory {
  readonly base: Directory;
  #overlay: Directory | undefined;
  readonly #subscriptions = new Set<Subscription>();

  constructor(base: Directory, overlay?: Directory) {
    this.base = base;
    this.#overlay = overlay;
  }

  /** The current overlay; undefined while no overlay is set. */
  get overlay(): Directory | undefined {
    return this.#overlay;
  }

  /** Replaces the overlay and notifies subscribers of the change. */
  setOverlay(next: Directory | undefined): void {
    const previous = this.#overlay;

    if (previous === next) {
      return;
    }

    this.#overlay = next;

    for (const subscription of [...this.#subscriptions]) {
      subscription.unsubscribeOverlay();
      subscription.unsubscribeOverlay = noop;

      for (const record of previous?.providers(subscription.contractId) ?? []) {
        if (!subscription.active) {
          break;
        }

        subscription.listener.removed(record);
      }

      if (subscription.active) {
        subscription.unsubscribeOverlay = this.#subscribeOverlay(subscription);
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
    return (
      this.base.isActive(record) || (this.#overlay?.isActive(record) ?? false)
    );
  }

  subscribe(contractId: string, listener: ProviderListener): () => void {
    const subscription: Subscription = {
      contractId,
      listener,
      active: true,
      unsubscribeOverlay: noop,
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
        if (subscription.active && this.#overlay === overlay) {
          subscription.listener.removed(record);
        }
      },
    });
  }
}
