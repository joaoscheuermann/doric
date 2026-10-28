// In-memory Web Storage for the preview frame (docs/architecture/bundles/
// papercraft/isolamento.md, decision 1). A frame of opaque origin throws on
// any access to `localStorage` or `sessionStorage`, and a component that
// reads either at import time would fail to load, so the runtime installs
// both before the revision's module is imported. Nothing persists: each
// frame starts empty and its storage dies with it.

/** A `Storage` that lives in memory, keys and values as strings. */
export const memoryStorage = (): Storage => {
  const items = new Map<string, string>();

  const storage = {
    get length(): number {
      return items.size;
    },
    key: (index: number): string | null =>
      [...items.keys()][Math.trunc(Number(index))] ?? null,
    getItem: (key: string): string | null => items.get(String(key)) ?? null,
    setItem: (key: string, value: string): void => {
      items.set(String(key), String(value));
    },
    removeItem: (key: string): void => {
      items.delete(String(key));
    },
    clear: (): void => {
      items.clear();
    },
  };

  return storage as Storage;
};

/**
 * Replaces the window's `localStorage` and `sessionStorage` with fresh
 * in-memory ones. On a `[Global]` window both are own configurable
 * properties, so defining them shadows the throwing accessors.
 */
export const installMemoryStorage = (win: Window): void => {
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(win, name, {
      configurable: true,
      enumerable: true,
      value: memoryStorage(),
      writable: false,
    });
  }
};
