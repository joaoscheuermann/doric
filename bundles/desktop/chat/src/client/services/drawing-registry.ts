// The window's tool and input renderers (chat.views/v1 1.2.0): what draws the
// calls of a tool or the prompts of an input source, keyed by the tool's name
// or the source's key, filled by `registerToolRenderer`/`registerInputRenderer`
// and emptied by their disposal. The conversation reads the values from here,
// one map per change.

/** One key's registration: its value and the bundle that registered it. */
export interface Drawing<T> {
  readonly value: T;
  readonly owner: string;
}

export interface DrawingRegistry<T> {
  /** The registered values by key, as one map per change. */
  entries(): ReadonlyMap<string, T>;
  /** The registration of `key`, else `undefined`. */
  holder(key: string): Drawing<T> | undefined;
  /** Registers `key`; answers its idempotent removal. */
  add(key: string, drawing: Drawing<T>): () => void;
  /** Called after every registration or its removal. */
  subscribe(listener: () => void): () => void;
}

export const createDrawingRegistry = <T>(): DrawingRegistry<T> => {
  const drawings = new Map<string, Drawing<T>>();
  const listeners = new Set<() => void>();
  let entries: ReadonlyMap<string, T> = new Map();

  const changed = (): void => {
    entries = new Map(
      [...drawings].map(([key, drawing]) => [key, drawing.value]),
    );
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Doric: a drawing registry listener failed:', error);
      }
    }
  };

  return {
    entries: () => entries,
    holder: (key) => drawings.get(key),
    add: (key, drawing) => {
      drawings.set(key, drawing);
      changed();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (drawings.get(key) === drawing) drawings.delete(key);
        changed();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
