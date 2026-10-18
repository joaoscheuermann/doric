// The terminal client's services as the stories seed them: an API whose
// calls succeed and do nothing, output watches that send a fixed snapshot
// (optionally followed by a few chunks, then nothing more), and a store over
// a fixed list of terminals.

import type { Disposable } from 'bundle/contracts';

import type { TerminalApi } from '../../src/client/api.js';
import type {
  Terminal,
  TerminalOutputUpdate,
} from '../../src/client/domain/terminals.js';
import type { TerminalWatchApi } from '../../src/client/output-watch.js';
import type { TerminalStore } from '../../src/client/store.js';
import { terminals as fixtureTerminals, outputs } from './fixtures.js';

const disposed: Disposable = { dispose: () => undefined };

export const storyTerminalApi = (
  terminals: readonly Terminal[] = fixtureTerminals,
): TerminalApi => ({
  list: async () => terminals,
  create: async () => terminals[0] as Terminal,
  snapshot: async (id) => ({
    terminal: terminals.find((terminal) => terminal.id === id) as Terminal,
    output: outputs[id] ?? '',
    offset: (outputs[id] ?? '').length,
    truncated: false,
  }),
  input: async () => undefined,
  resize: async () => undefined,
  stop: async () => undefined,
});

/** What one terminal's watch sends: a snapshot, then timed chunks. */
export interface StoryWatch {
  readonly snapshot?: string;
  readonly truncated?: boolean;
  /** Output appended after the snapshot, one chunk every `intervalMs`. */
  readonly chunks?: readonly string[];
  readonly intervalMs?: number;
  /** A watch that fails instead of sending output. */
  readonly error?: string;
}

export const storyWatches = (
  watches: Readonly<Record<string, StoryWatch>> = {},
): TerminalWatchApi => ({
  watchProject: () => () => undefined,
  watch: (id, _after, listener: (update: TerminalOutputUpdate) => void) => {
    const watch = watches[id] ?? {};
    if (watch.error !== undefined) {
      listener({ kind: 'error', message: watch.error });
      return () => undefined;
    }
    const snapshot = watch.snapshot ?? outputs[id] ?? '';
    listener({
      kind: 'snapshot',
      data: snapshot,
      sequence: snapshot.length,
      ...(watch.truncated === true ? { truncated: true } : {}),
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    let sequence = snapshot.length;
    (watch.chunks ?? []).forEach((chunk, index) => {
      sequence += chunk.length;
      const at = sequence;
      timers.push(
        setTimeout(
          () => listener({ kind: 'output', data: chunk, sequence: at }),
          (index + 1) * (watch.intervalMs ?? 700),
        ),
      );
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  },
});

/** A store over a fixed list; create and stop change nothing. */
export const storyTerminalStore = (
  terminals: readonly Terminal[] = fixtureTerminals,
): TerminalStore => ({
  follow: () => undefined,
  unfollow: () => undefined,
  terminals: () => terminals,
  threadTerminals: (threadId) =>
    terminals.filter((terminal) => terminal.threadId === threadId),
  create: async () => undefined,
  stop: () => undefined,
  subscribe: () => disposed,
  dispose: () => undefined,
});
