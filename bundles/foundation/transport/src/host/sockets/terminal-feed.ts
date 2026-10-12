import type { Disposable } from 'bundle/contracts';
import type { TerminalService, TerminalWatchItem } from 'terminal/contracts';

/**
 * The live terminal notices of the Projects the `/projects` namespace
 * serves, from `terminal/v1.watchProject` (stage 10 §4): one stream per
 * Project while any socket subscribes to it. The streams follow the provider:
 * a new `terminal/v1` provider (a generation change) is watched again for
 * every subscribed Project, and a provider that leaves ends its streams.
 */
export interface TerminalFeed {
  /** Delivers the Project's updates, removals and output until disposed. */
  watch(
    projectId: string,
    listener: (item: TerminalWatchItem) => void,
  ): Disposable;
}

export interface TerminalFeedSource extends TerminalFeed {
  /** Follows one provider; the returned cleanup ends its streams. */
  attach(terminal: Pick<TerminalService, 'watchProject'>): () => void;
}

interface Watcher {
  readonly projectId: string;
  readonly listener: (item: TerminalWatchItem) => void;
  stream?: Disposable;
}

export const createTerminalFeed = (): TerminalFeedSource => {
  const watchers = new Set<Watcher>();
  let provider: Pick<TerminalService, 'watchProject'> | undefined;

  const open = (watcher: Watcher) => {
    if (provider === undefined) return;
    try {
      watcher.stream = provider.watchProject(watcher.projectId, {
        next: (item) => {
          if (watchers.has(watcher)) watcher.listener(item);
        },
      });
    } catch {
      // A provider leaving mid-call: the next one watches again.
      watcher.stream = undefined;
    }
  };
  const close = (watcher: Watcher) => {
    const stream = watcher.stream;
    watcher.stream = undefined;
    try {
      stream?.dispose();
    } catch {
      // The provider is gone already.
    }
  };

  return {
    watch: (projectId, listener) => {
      const watcher: Watcher = { projectId, listener };
      watchers.add(watcher);
      open(watcher);
      return {
        dispose: () => {
          if (!watchers.delete(watcher)) return;
          close(watcher);
        },
      };
    },
    attach: (terminal) => {
      provider = terminal;
      for (const watcher of watchers) open(watcher);
      return () => {
        if (provider === terminal) provider = undefined;
        for (const watcher of watchers) close(watcher);
      };
    },
  };
};
