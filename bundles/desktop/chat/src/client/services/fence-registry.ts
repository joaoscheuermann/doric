// The window's fence renderers (openui.md D1): which element draws the fences
// of each tag, filled by `chat.views/v1.registerFenceRenderer` and emptied by
// its disposal. The conversation and `watchFences` read the tags from here,
// one set per change.

/** One tag's fence renderer: its element and the bundle that registered it. */
export interface FenceRenderer {
  readonly elementTag: string;
  readonly owner: string;
}

export interface FenceRegistry {
  /** The registered tags, as one set per change. */
  tags(): ReadonlySet<string>;
  /** The renderer of `tag`, else `undefined`. */
  rendererFor(tag: string): FenceRenderer | undefined;
  /** Registers `tag`'s renderer; answers its idempotent removal. */
  add(tag: string, renderer: FenceRenderer): () => void;
  /** Called after every registration or its removal. */
  subscribe(listener: () => void): () => void;
}

export const createFenceRegistry = (): FenceRegistry => {
  const renderers = new Map<string, FenceRenderer>();
  const listeners = new Set<() => void>();
  let tags: ReadonlySet<string> = new Set();

  const changed = (): void => {
    tags = new Set(renderers.keys());
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Doric: a fence registry listener failed:', error);
      }
    }
  };

  return {
    tags: () => tags,
    rendererFor: (tag) => renderers.get(tag),
    add: (tag, renderer) => {
      renderers.set(tag, renderer);
      changed();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (renderers.get(tag) === renderer) renderers.delete(tag);
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
