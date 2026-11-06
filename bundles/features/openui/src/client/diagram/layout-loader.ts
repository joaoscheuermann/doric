// The layout loader (openui-diagrams.md F6): the renderer chunk's single
// path to the layout chunk. It loads the chunk at the first layout and keeps
// the load, resolved or rejected, for the window's life.

import type { LayoutGraph, LayoutResult } from './layout-types.js';

/** What the layout chunk module provides. */
export type LayoutModule = {
  readonly layout: (graph: LayoutGraph) => Promise<LayoutResult>;
};

/**
 * A layout function that calls `load` at its first call and never again,
 * then delegates to the module's `layout`. A rejected load rejects that
 * call and every later one with the same error. No queue, no cache.
 */
export const createLayoutLoader = (
  load: () => Promise<LayoutModule>,
): ((graph: LayoutGraph) => Promise<LayoutResult>) => {
  let loading: Promise<LayoutModule> | undefined;
  return async (graph) => {
    loading ??= load();
    return (await loading).layout(graph);
  };
};
