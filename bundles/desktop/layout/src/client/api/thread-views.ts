// The views a window holds on the Threads it shows
// (docs/designs/thread-archive.md §6, §10.8): one
// `runtime.threads/v1.viewThread` stream per Thread on screen, followed with
// `followStream`, so the archiver never archives a Thread a window shows.

import type { RuntimeThreads } from 'runtime/contracts';

import { type ConnectionSource, followStream } from './project-watch.js';

export interface ThreadViewsOptions {
  readonly runtime: Pick<RuntimeThreads, 'viewThread'>;
  readonly connection: ConnectionSource;
  readonly schedule: (run: () => void, ms: number) => () => void;
}

/** The window's views: one held per Thread id last `set`. */
export interface ThreadViews {
  /**
   * Follows one `viewThread` stream per id of `ids` not yet followed and
   * stops the streams of followed ids not in `ids`; a followed id still in
   * `ids` keeps its stream (no reopen). Never throws.
   */
  set(ids: ReadonlySet<string>): void;
  /** Stops every stream; a later `set` follows again. Idempotent. */
  close(): void;
}

/**
 * The window's Thread views. Each stream is followed with `followStream`
 * (`api/project-watch.ts`): a silent end (`disconnected`, `unavailable`,
 * `generation_lost`) opens the view again, so a runtime hand-over keeps the
 * view (D29). Items are ignored. A failing end (such as `not_found` for a
 * missing Thread) drops the id from the followed set, logs nothing and shows
 * nothing, so the next `set` that still names the id opens it again.
 */
export const createThreadViews = ({
  runtime,
  connection,
  schedule,
}: ThreadViewsOptions): ThreadViews => {
  const followed = new Map<string, () => void>();

  const follow = (threadId: string) => {
    // Set when the stream fails, so a failure while it opens is not followed.
    let failed = false;
    const stop = followStream({
      open: (observer) => runtime.viewThread({ threadId }, observer),
      connection,
      schedule,
      onItem: () => undefined,
      onFailure: () => {
        failed = true;
        followed.delete(threadId);
      },
    });
    if (!failed) followed.set(threadId, stop);
  };

  const close = () => {
    for (const stop of followed.values()) stop();
    followed.clear();
  };

  return {
    set: (ids) => {
      for (const [id, stop] of followed) {
        if (ids.has(id)) continue;
        stop();
        followed.delete(id);
      }
      for (const id of ids) if (!followed.has(id)) follow(id);
    },
    close,
  };
};
