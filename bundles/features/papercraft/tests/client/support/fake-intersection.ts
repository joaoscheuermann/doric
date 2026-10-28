// A fake `IntersectionObserver`: happy-dom lays nothing out, so nothing is
// ever seen on screen unless a test says so. Installed as the global, it
// records what each observer watches, and `intersect` tells every observer of
// an element that the element came into view (wholly, partly) or left it.

interface Watcher {
  readonly callback: IntersectionObserverCallback;
  readonly observer: IntersectionObserver;
  readonly targets: Set<Element>;
}

export interface FakeIntersection {
  /** Reports an element's visible share (0: out of view, 1: wholly in view). */
  intersect(target: Element, ratio: number): void;
  /** Restores the global the fake replaced. */
  restore(): void;
}

/** Installs the fake as the global `IntersectionObserver`. */
export const fakeIntersection = (): FakeIntersection => {
  const watchers = new Set<Watcher>();
  const previous = (globalThis as { IntersectionObserver?: unknown })
    .IntersectionObserver;

  class FakeIntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds: readonly number[] = [0];
    readonly #watcher: Watcher;

    constructor(callback: IntersectionObserverCallback) {
      this.#watcher = {
        callback,
        observer: this as unknown as IntersectionObserver,
        targets: new Set(),
      };
      watchers.add(this.#watcher);
    }

    observe(target: Element): void {
      this.#watcher.targets.add(target);
    }

    unobserve(target: Element): void {
      this.#watcher.targets.delete(target);
    }

    disconnect(): void {
      this.#watcher.targets.clear();
      watchers.delete(this.#watcher);
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  });

  return {
    intersect: (target, ratio) => {
      for (const watcher of [...watchers]) {
        if (!watcher.targets.has(target)) continue;

        watcher.callback(
          [
            {
              target,
              isIntersecting: ratio > 0,
              intersectionRatio: ratio,
              time: 0,
              boundingClientRect: target.getBoundingClientRect(),
              intersectionRect: target.getBoundingClientRect(),
              rootBounds: null,
            } as IntersectionObserverEntry,
          ],
          watcher.observer,
        );
      }
    },
    restore: () => {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        writable: true,
        value: previous,
      });
    },
  };
};
