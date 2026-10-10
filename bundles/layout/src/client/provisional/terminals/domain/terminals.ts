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
};

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

export type TerminalsApi = {
  list(projectId: string): Promise<readonly Terminal[]>;
  create(threadId: string): Promise<Terminal>;
  watchProject(
    projectId: string,
    listener: (update: TerminalUpdate) => void,
  ): () => void;
  watch(
    id: string,
    afterSequence: number,
    listener: (update: TerminalOutputUpdate) => void,
  ): () => void;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  stop(id: string): Promise<void>;
};

export const terminalLabel = (terminal: Terminal, now: number): string => {
  if (terminal.origin === 'user') return terminal.command;
  const elapsed = Math.max(
    0,
    Math.floor((now - Date.parse(terminal.startedAt)) / 1000),
  );
  const time = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;
  const limit = timeoutLabel(terminal.timeoutMs);
  return `${terminal.command} · ${time} (${limit})`;
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

/** Only the unseen suffix of a replayed UTF-16 output chunk reaches the emulator. */
export const unseenOutput = (
  data: string,
  offset: number,
  seen: number,
): string =>
  offset <= seen ? '' : data.slice(Math.max(0, seen - (offset - data.length)));
