// The owner of the reader's views: the persisted list, each view's status, the
// windows, and the loop that keeps asking.
//
// The desktopMain environment is the only thing that can own this state (it
// survives the window that drew it) but it cannot reach the host: a generation
// resolves the providers of its own environment plus the kernel's `doric.*`
// services, and `screen.sessions/v2` is a host contract. So the owner decides
// and the window, which does have a host bridge, dials: every attach the owner
// wants appears in the state's `dials`, the window answers with `deliver`, and
// the answer becomes a status here.

import { randomUUID } from 'node:crypto';

import type { Disposable } from 'bundle/contracts';

import type {
  ScreenAttachReport,
  ScreenAttachRequest,
  ScreenView,
  ScreenViewsState,
} from '../contracts/index.js';
import {
  labelOf,
  retryDelayMs,
  statusOf,
  TICK_MS,
  windowActionFor,
} from './status.js';
import { createViewsFile, type StoredView, type ViewsFile } from './store.js';
import {
  applyWindowAction,
  type OpenScreenWindow,
  openRequestOf,
  type ScreenWindows,
} from './windows.js';

/** What one call needs from the desktopMain generation. */
export interface ScreenViewsEnv {
  /** The bundle's own cache directory (`doric.cache/v1`), resolved per call. */
  readonly directory: () => Promise<string>;
  /** The platform's window calls. */
  readonly windows: ScreenWindows;
}

/** The clock and the timer of the heal loop, injectable for tests. */
export interface ScreenViewsClock {
  now(): number;
  every(ms: number, run: () => void): Disposable;
}

/** How long a dial waits for its answer before the view dials again. */
export const DIAL_TIMEOUT_MS = 5_000;

const systemClock: ScreenViewsClock = {
  now: () => Date.now(),
  every: (ms, run) => {
    const timer = setInterval(run, ms);

    return {
      dispose: () => clearInterval(timer),
    };
  },
};

/** One held view: what the reader sees plus what the owner knows of its window. */
interface Entry {
  view: ScreenView;
  /** The path the window was opened (or last navigated) with. */
  openedPath?: string;
  /** When the next attach is due, on the owner's clock. */
  nextDialAt: number;
  /** The sequence of the dial in flight, zero when none is. */
  awaiting: number;
  /** When that dial was sent, for the answer timeout. */
  dialedAt: number;
}

export interface ScreenViewsOptions {
  readonly clock?: ScreenViewsClock;
  /** How a new view is identified; tests inject a counter. */
  readonly id?: () => string;
}

export interface ScreenViews {
  list(env: ScreenViewsEnv): Promise<readonly ScreenView[]>;
  add(
    input: { readonly projectId: string; readonly label?: string },
    env: ScreenViewsEnv,
  ): Promise<ScreenView>;
  remove(viewId: string, env: ScreenViewsEnv): Promise<void>;
  open(viewId: string, env: ScreenViewsEnv): Promise<void>;
  retry(viewId: string, env: ScreenViewsEnv): Promise<void>;
  deliver(report: ScreenAttachReport, env: ScreenViewsEnv): Promise<void>;
  /**
   * Registers `listener` for the state, pushes it once the cache is read (only
   * when `revision` differs from the state's own) and after every change.
   */
  watch(
    revision: number,
    listener: (state: ScreenViewsState) => void,
    env: ScreenViewsEnv,
  ): Disposable;
  dispose(): void;
}

const frozen = <T>(values: readonly T[]): readonly T[] =>
  Object.freeze([...values]);

/**
 * The views owner over one cache file and one clock. Every method is tolerant:
 * a directory that cannot be read or written leaves the app with an in-memory
 * list, and a window call that fails is reported by the platform, not thrown at
 * the row that asked for it.
 */
export const createScreenViews = (
  options: ScreenViewsOptions = {},
): ScreenViews => {
  const clock = options.clock ?? systemClock;
  const id = options.id ?? (() => randomUUID());
  const entries = new Map<string, Entry>();
  const wanted = new Set<string>();
  const listeners = new Set<
    (revision: number, state: ScreenViewsState) => void
  >();
  let file: ViewsFile | undefined;
  let loading: Promise<void> | undefined;
  let loaded = false;
  let loop: Disposable | undefined;
  let nextSeq = 1;
  let revision = 1;

  const fileOf = (env: ScreenViewsEnv): ViewsFile => {
    file ??= createViewsFile(env.directory);

    return file;
  };

  const views = (): readonly ScreenView[] =>
    frozen([...entries.values()].map((entry) => entry.view));

  const dials = (): readonly ScreenAttachRequest[] =>
    frozen(
      [...entries.values()].flatMap((entry) =>
        entry.awaiting === 0
          ? []
          : [
              {
                viewId: entry.view.id,
                projectId: entry.view.projectId,
                seq: entry.awaiting,
              },
            ],
      ),
    );

  const state = (): ScreenViewsState => ({
    revision,
    views: views(),
    dials: dials(),
  });

  /**
   * Announces a change: the revision moves first, so a listener that already
   * holds the previous state is never sent it twice.
   */
  const changed = (): void => {
    revision += 1;

    const current = state();

    for (const listener of [...listeners]) {
      try {
        listener(revision, current);
      } catch {
        // One listener never reaches another, or the store.
      }
    }
  };

  const load = async (env: ScreenViewsEnv): Promise<void> => {
    if (loaded) return;
    loading ??= (async () => {
      const stored = await fileOf(env).read();

      for (const view of stored) {
        if (entries.has(view.id)) continue;

        entries.set(view.id, {
          view: { ...view, status: { kind: 'waiting' } },
          nextDialAt: 0,
          awaiting: 0,
          dialedAt: 0,
        });
      }

      loaded = true;
    })();

    try {
      await loading;
    } catch {
      // A cache that cannot be read is an empty list, never a failure.
      loaded = true;
    }
  };

  const persist = async (env: ScreenViewsEnv): Promise<void> => {
    const stored: StoredView[] = [...entries.values()].map(({ view }) => ({
      id: view.id,
      label: view.label,
      projectId: view.projectId,
    }));

    try {
      await fileOf(env).write(stored);
    } catch {
      // Best effort: the in-memory list stays the truth for this run.
    }
  };

  const requestOf = (entry: Entry): OpenScreenWindow =>
    openRequestOf({
      viewId: entry.view.id,
      label: entry.view.label,
      path: entry.view.status.kind === 'ready' ? entry.view.status.path : '',
    });

  /**
   * Applies the window decision of one view: opens a window the reader asked
   * for, navigates one whose screen moved, focuses one that is already right.
   */
  const applyWindow = async (
    entry: Entry,
    env: ScreenViewsEnv,
    focus: boolean,
  ): Promise<void> => {
    const action = windowActionFor({
      status: entry.view.status,
      openedPath: entry.openedPath,
      wanted: wanted.has(entry.view.id),
      focus,
    });

    if (action.kind === 'none') return;

    const outcome = await applyWindowAction({
      windows: env.windows,
      action,
      request: requestOf(entry),
    });

    if (outcome === 'opened' || outcome === 'navigated') {
      entry.openedPath =
        entry.view.status.kind === 'ready' ? entry.view.status.path : undefined;
      wanted.delete(entry.view.id);
      return;
    }

    if (outcome === 'absent' && entry.view.status.kind === 'ready') {
      // The key we believed open is gone (the reader closed that window, or
      // the app restarted): forget the stale path and open the window again.
      entry.openedPath = undefined;

      const reopened = await applyWindowAction({
        windows: env.windows,
        action: { kind: 'open', path: entry.view.status.path },
        request: requestOf(entry),
      });

      if (reopened === 'opened') {
        entry.openedPath = entry.view.status.path;
        wanted.delete(entry.view.id);
      }
    }
  };

  /** One pass of the heal loop: dial every view whose attach is due. */
  const tick = (): void => {
    const now = clock.now();
    let dirtied = false;

    for (const entry of entries.values()) {
      if (entry.awaiting !== 0 && now - entry.dialedAt > DIAL_TIMEOUT_MS) {
        // A dial nobody answered (no window was watching): ask again.
        entry.awaiting = 0;
        dirtied = true;
      }

      if (entry.awaiting !== 0) continue;

      const delay = retryDelayMs(
        entry.view.status,
        entry.openedPath !== undefined,
      );

      if (delay === undefined || now < entry.nextDialAt) continue;

      entry.awaiting = nextSeq;
      entry.dialedAt = now;
      entry.nextDialAt = now + delay;
      nextSeq += 1;
      dirtied = true;
    }

    if (dirtied) changed();
  };

  const ensureLoop = (): void => {
    loop ??= clock.every(TICK_MS, () => {
      try {
        tick();
      } catch {
        // A pass that fails never stops the loop.
      }
    });
  };

  const entryOf = (viewId: string): Entry | undefined => entries.get(viewId);

  return {
    list: async (env) => {
      await load(env);
      ensureLoop();

      return views();
    },
    add: async (input, env) => {
      await load(env);
      ensureLoop();

      const watched = [...entries.values()].find(
        (entry) => entry.view.projectId === input.projectId,
      );

      // One screen per Project: asking again is opening the view that watches
      // it, which is what the old header button did for its panel.
      if (watched !== undefined) {
        wanted.add(watched.view.id);
        await applyWindow(watched, env, true);

        return watched.view;
      }

      const entry: Entry = {
        view: {
          id: id(),
          label: labelOf(input),
          projectId: input.projectId,
          status: { kind: 'waiting' },
        },
        nextDialAt: 0,
        awaiting: 0,
        dialedAt: 0,
      };

      entries.set(entry.view.id, entry);
      await persist(env);
      changed();

      return entry.view;
    },
    remove: async (viewId, env) => {
      await load(env);

      if (!entries.delete(viewId)) return;

      wanted.delete(viewId);
      await persist(env);
      changed();
    },
    open: async (viewId, env) => {
      await load(env);
      ensureLoop();

      const entry = entryOf(viewId);

      if (entry === undefined) return;

      if (entry.view.status.kind !== 'ready') {
        // No window yet: remember the wish, and dial now so the status
        // resolves and the window opens as soon as it is ready.
        wanted.add(viewId);
        entry.nextDialAt = 0;

        return;
      }

      wanted.add(viewId);
      await applyWindow(entry, env, true);
    },
    retry: async (viewId, env) => {
      await load(env);
      ensureLoop();

      const entry = entryOf(viewId);

      if (entry === undefined) return;

      if (entry.view.status.kind === 'ready') {
        await applyWindow(entry, env, true);

        return;
      }

      entry.nextDialAt = 0;
      entry.awaiting = 0;
    },
    deliver: async (report, env) => {
      await load(env);

      const entry = entryOf(report.viewId);

      if (entry === undefined || report.seq !== entry.awaiting) {
        // A view that is gone, or an answer to a dial that was replaced.
        return;
      }

      entry.awaiting = 0;
      entry.view = { ...entry.view, status: statusOf(report.answer) };
      await applyWindow(entry, env, false);
      changed();
    },
    watch: (revision, listener, env) => {
      let held = revision;

      const notify = (current: number, snapshot: ScreenViewsState): void => {
        if (current === held) return;

        held = current;

        try {
          listener(snapshot);
        } catch {
          // A listener that throws never reaches the owner.
        }
      };

      listeners.add(notify);
      void load(env)
        .then(() => {
          if (!listeners.has(notify)) return;

          if (revision !== state().revision) listener(state());
          held = state().revision;
        })
        .catch(() => undefined);

      return {
        dispose: () => {
          listeners.delete(notify);
        },
      };
    },
    dispose: () => {
      loop?.dispose();
      loop = undefined;
      listeners.clear();
      entries.clear();
      wanted.clear();
      loaded = false;
      loading = undefined;
      file = undefined;
    },
  };
};
