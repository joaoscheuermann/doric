import { randomUUID } from 'node:crypto';

import type { TerminalInput, TerminalResult } from 'host';
import type { Sandbox, SandboxProcess } from 'sandbox';

import type { WorkspacePublisher } from './types.js';

export interface Terminal {
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
}
export interface TerminalOutput {
  readonly projectId: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
  /** Exclusive UTF-16 offset after this chunk. */
  readonly offset: number;
}
export interface TerminalSnapshot {
  readonly terminal: Terminal;
  readonly output: string;
  readonly offset: number;
  readonly truncated: boolean;
}
interface Session {
  terminal: Terminal;
  readonly controller: AbortController;
  process?: SandboxProcess;
  starting?: Promise<SandboxProcess>;
  output: string;
  offset: number;
  stopping?: Promise<void>;
}
const OUTPUT_LIMIT = 1_048_576;
// Bash supplies commands through terminal metadata, never inferred keystrokes.
const manualCommand = [
  'bash',
  '-c',
  `exec bash --noprofile --rcfile /dev/fd/3 -i 3<<'DORIC_SHELL_INIT'
PROMPT_COMMAND='printf "\\033]633;E;bash\\007"'
trap 'if [[ "$BASH_COMMAND" != "$PROMPT_COMMAND" ]]; then printf "\\033]633;E;%s\\007" "$BASH_COMMAND"; fi' DEBUG
DORIC_SHELL_INIT`,
];

/** Process-local sessions; finished commands leave no retained terminal. */
export const createTerminalRegistry = (
  publisher: WorkspacePublisher,
  redactions: () => readonly string[] = () => [],
) => {
  const redact = (text: string) =>
    redactions()
      .filter(Boolean)
      .reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), text);
  const sessions = new Map<string, Session>();
  const remove = (session: Session) => {
    if (!sessions.delete(session.terminal.id)) return;
    publisher.terminalRemoved?.({
      projectId: session.terminal.projectId,
      threadId: session.terminal.threadId,
      terminalId: session.terminal.id,
    });
  };
  const stop = async (id: string): Promise<boolean> => {
    const session = sessions.get(id);
    if (session === undefined) return false;
    session.controller.abort();
    session.stopping ??= (async () => {
      const process =
        session.process ?? (await session.starting?.catch(() => undefined));
      await process?.terminate();
    })();
    await session.stopping;
    remove(session);
    return true;
  };
  const start = async (options: {
    readonly sandbox: Sandbox;
    readonly projectId: string;
    readonly threadId: string;
    readonly origin: 'agent' | 'user';
    readonly input: TerminalInput;
    readonly signal?: AbortSignal;
    readonly cols?: number;
    readonly rows?: number;
  }) => {
    if (options.sandbox.start === undefined)
      throw new Error('Live terminals are unavailable.');
    options.signal?.throwIfAborted();
    const started = Date.now();
    const { input } = options;
    const session: Session = {
      terminal: {
        id: randomUUID(),
        projectId: options.projectId,
        threadId: options.threadId,
        origin: options.origin,
        command: redact(input.command),
        cwd: input.cwd,
        startedAt: new Date(started).toISOString(),
        timeoutMs: input.timeoutMs || null,
        state: 'starting',
        pty: input.pty ?? false,
      },
      controller: new AbortController(),
      output: '',
      offset: 0,
    };
    sessions.set(session.terminal.id, session);
    publisher.terminalUpdated?.(session.terminal);
    let timedOut = false;
    const abort = () => session.controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            abort();
          }, input.timeoutMs)
        : undefined;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    let metadata = '';
    const commandMetadata = (data: string) => {
      if (options.origin !== 'user') return data;
      metadata += data;
      let output = '';
      for (;;) {
        const start = metadata.indexOf('\u001b]633;E;');
        if (start < 0) {
          // Keep a possible prefix split across transport chunks.
          let pending = 0;
          for (let length = 1; length < 8; length++)
            if (metadata.endsWith('\u001b]633;E;'.slice(0, length)))
              pending = length;
          output += metadata.slice(0, metadata.length - pending);
          metadata = metadata.slice(metadata.length - pending);
          return output;
        }
        output += metadata.slice(0, start);
        metadata = metadata.slice(start);
        const end = metadata.indexOf('\u0007', 8);
        if (end < 0) {
          if (metadata.length > 8192) {
            output += metadata;
            metadata = '';
          }
          return output;
        }
        const command =
          [...redact(metadata.slice(8, end))]
            .filter(
              (character) =>
                character.charCodeAt(0) >= 32 &&
                character.charCodeAt(0) !== 127,
            )
            .join('')
            .slice(0, 512) || 'bash';
        session.terminal = { ...session.terminal, command };
        publisher.terminalUpdated?.(session.terminal);
        metadata = metadata.slice(end + 1);
      }
    };
    let pendingSecret = '';
    const emit = (chunk: string, flush = false) => {
      if (!sessions.has(session.terminal.id)) return;
      const text = redact(pendingSecret + chunk);
      let keep = 0;
      if (!flush)
        for (const secret of redactions().filter(Boolean)) {
          for (
            let size = 1;
            size < secret.length && size <= text.length;
            size++
          ) {
            if (text.endsWith(secret.slice(0, size)))
              keep = Math.max(keep, size);
          }
        }
      pendingSecret = text.slice(text.length - keep);
      const data = text.slice(0, text.length - keep);
      if (data === '') return;
      session.offset += data.length;
      session.output = (session.output + data).slice(-OUTPUT_LIMIT);
      publisher.terminalOutput?.({
        projectId: options.projectId,
        threadId: options.threadId,
        terminalId: session.terminal.id,
        data,
        offset: session.offset,
      });
    };
    try {
      session.starting = options.sandbox.start({
        cmd:
          options.origin === 'user'
            ? manualCommand
            : ['sh', '-lc', input.command],
        cwd: input.cwd,
        tty: input.pty ?? false,
        ...(input.pty
          ? { env: ['TERM=xterm-256color', 'COLORTERM=truecolor'] }
          : {}),
        ...(options.cols === undefined ? {} : { cols: options.cols }),
        ...(options.rows === undefined ? {} : { rows: options.rows }),
        signal: session.controller.signal,
        onOutput: ({ data: chunk }) => {
          if (!sessions.has(session.terminal.id)) return;
          emit(commandMetadata(chunk));
        },
      });
      session.process = await session.starting;
      if (session.controller.signal.aborted) {
        await session.process.terminate();
        // Observe the provider rejection even when cancellation won startup.
        void session.process.result.catch(() => undefined);
        session.controller.signal.throwIfAborted();
      }
      session.terminal = { ...session.terminal, state: 'running' };
      publisher.terminalUpdated?.(session.terminal);
      const result: Promise<TerminalResult> = session.process.result
        .then<TerminalResult, TerminalResult>(
          (value) => ({
            terminalId: session.terminal.id,
            stdout: value.stdout,
            stderr: value.stderr,
            exitCode: value.exitCode ?? -1,
            durationMs: Date.now() - started,
            reason: timedOut
              ? 'timeout'
              : session.controller.signal.aborted
                ? 'terminated'
                : 'exited',
          }),
          () => ({
            terminalId: session.terminal.id,
            stdout: '',
            stderr: timedOut
              ? 'Terminal timeout exceeded.'
              : session.controller.signal.aborted
                ? 'Terminal terminated.'
                : 'Terminal execution failed.',
            exitCode: -1,
            durationMs: Date.now() - started,
            reason: timedOut
              ? 'timeout'
              : session.controller.signal.aborted
                ? 'terminated'
                : 'failed',
          }),
        )
        .then((value) => {
          cleanup();
          emit('', true);
          if (options.origin === 'agent') remove(session);
          else if (sessions.has(session.terminal.id)) {
            session.terminal = { ...session.terminal, state: 'exited' };
            publisher.terminalUpdated?.(session.terminal);
          }
          return value;
        });
      return { terminal: session.terminal, result };
    } catch (error) {
      cleanup();
      remove(session);
      throw error;
    }
  };
  return {
    start,
    stop,
    list: (projectId: string): readonly Terminal[] =>
      [...sessions.values()]
        .filter(({ terminal }) => terminal.projectId === projectId)
        .map(({ terminal }) => terminal),
    snapshot: (id: string, after = 0): TerminalSnapshot | undefined => {
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      const base = session.offset - session.output.length;
      return {
        terminal: session.terminal,
        output: session.output.slice(Math.max(0, after - base)),
        offset: session.offset,
        truncated: after < base,
      };
    },
    input: async (id: string, data: string) => {
      const process = sessions.get(id)?.process;
      if (process === undefined) return false;
      await process.write(data);
      return true;
    },
    resize: async (id: string, cols: number, rows: number) => {
      const process = sessions.get(id)?.process;
      if (process === undefined) return false;
      await process.resize(cols, rows);
      return true;
    },
    close: async (threadIds: readonly string[]) => {
      const ids = new Set(threadIds);
      await Promise.all(
        [...sessions.values()]
          .filter(({ terminal }) => ids.has(terminal.threadId))
          .map(({ terminal }) => stop(terminal.id)),
      );
    },
  };
};
export type TerminalRegistry = ReturnType<typeof createTerminalRegistry>;
