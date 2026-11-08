// The entry's chunk loader and folds (conversation-openui.md D29, openui.md
// D4): the renderer chunk is imported once per window, at its first fence,
// with its sheet; the window's folds are made with the chunk's
// `mergeStatements` and `isQuestionLine`.

import { createProgramFolds, type ProgramFolds } from '../contracts/index.js';

/** The chunk's exports, as a type only: the entry bundles none of its code. */
export type RendererChunk = typeof import('./chunks/renderer.js');

export interface ChunkLoader {
  /** Starts the import at the first call and returns that promise from then on; a rejected import is never retried. */
  load(): Promise<RendererChunk>;
  /** Once `load` has resolved: the chunk, and the window's `ProgramFolds`, made with the chunk's `mergeStatements` and `isQuestionLine`. */
  loaded():
    | { readonly chunk: RendererChunk; readonly folds: ProgramFolds }
    | undefined;
}

/** A loader over `importChunk`, which it calls at most once. */
export const createChunkLoader = (
  importChunk: () => Promise<RendererChunk>,
): ChunkLoader => {
  let loading: Promise<RendererChunk> | undefined;
  let loaded: ReturnType<ChunkLoader['loaded']>;

  return {
    load: () => {
      loading ??= importChunk().then((chunk) => {
        loaded = {
          chunk,
          folds: createProgramFolds(chunk.mergeStatements, isQuestionLine),
        };
        return chunk;
      });
      return loading;
    },
    loaded: () => loaded,
  };
};

/** The chunk's sheet: react-ui's layered sheet and Doric's tokens (D31), built beside the chunk. */
const SHEET = './chunks/renderer-styles.css';

/** The chunk, built beside the entry as `client/chunks/renderer.js`. */
const CHUNK = './chunks/renderer.js';

/** The window's loader: its importer appends the chunk's `<link rel="stylesheet">` once, then imports the chunk. */
export const chunkLoader: ChunkLoader = createChunkLoader(() => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL(SHEET, import.meta.url).href;
  document.head.append(link);
  return import(new URL(CHUNK, import.meta.url).href) as Promise<RendererChunk>;
});

/** D21's first-line test, which the fold calls (D4): `/^root\s*=\s*AskForm\(/`. */
export const isQuestionLine = (line: string): boolean =>
  /^root\s*=\s*AskForm\(/.test(line);
