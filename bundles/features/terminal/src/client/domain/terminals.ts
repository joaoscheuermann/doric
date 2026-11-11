// The terminal client's model (moved from the layout's provisional
// `terminals/domain/terminals.ts`, before that the renderer's
// `domain/terminals.ts`): the record a window holds, the labels it shows and
// the unseen part of a replayed output chunk.

export type Terminal = {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly origin: 'agent' | 'user';
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly timeoutMs: number | null;
  readonly state: 'starting' | 'running' | 'exited';
  readonly pty: boolean;
  /** terminal/v1 1.2.0: the reader's name for it (A13); absent when none. */
  readonly name?: string;
};

/** What names a terminal on its row and tab: its name, else its command. */
export const terminalTitle = (terminal: Terminal): string =>
  terminal.name ?? (terminal.command || 'Terminal');

export type TerminalUpdate =
  | { readonly kind: 'snapshot'; readonly terminals: readonly Terminal[] }
  | { readonly kind: 'updated'; readonly terminal: Terminal }
  | { readonly kind: 'removed'; readonly terminalId: string }
  | { readonly kind: 'error'; readonly message: string };

export type TerminalOutputUpdate =
  | {
      readonly kind: 'snapshot' | 'output';
      readonly data: string;
      readonly sequence: number;
      readonly truncated?: boolean;
    }
  | { readonly kind: 'error'; readonly message: string };

export const terminalLabel = (terminal: Terminal, now: number): string => {
  const title = terminal.name ?? terminal.command;
  if (terminal.origin === 'user') return title;
  const elapsed = Math.max(
    0,
    Math.floor((now - Date.parse(terminal.startedAt)) / 1000),
  );
  const time = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  const limit = timeoutLabel(terminal.timeoutMs);
  return `${title} · ${time} (${limit})`;
};

const timeoutLabel = (milliseconds: number | null): string => {
  if (milliseconds === null) return 'no limit';
  if (milliseconds < 1000) return '<1 sec';
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return [
    minutes > 0 ? `${minutes} min` : '',
    remainder > 0 ? `${remainder} sec` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

export const threadTerminals = (
  terminals: readonly Terminal[],
  threadId: string,
): readonly Terminal[] =>
  terminals.filter((terminal) => terminal.threadId === threadId);

/**
 * Whether the terminal keeps its Thread active: an agent's terminal that has
 * not exited (`starting` or `running`). The reader's own terminals never do.
 */
export const isAgentBusy = (terminal: Terminal): boolean =>
  terminal.origin === 'agent' && terminal.state !== 'exited';

/** Only the unseen suffix of a replayed UTF-16 output chunk reaches the emulator. */
export const unseenOutput = (
  data: string,
  offset: number,
  seen: number,
): string =>
  offset <= seen ? '' : data.slice(Math.max(0, seen - (offset - data.length)));
