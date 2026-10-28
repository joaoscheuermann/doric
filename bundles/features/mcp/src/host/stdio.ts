// The MCP SDK transport over a process the Project's sandbox runs: what the
// client sends is written to the process's stdin as newline-delimited
// JSON-RPC, and each complete stdout line is one message back. The process
// never runs on the host: it is whatever `start` launches in the sandbox.

import {
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { SandboxProcess, SandboxProcessOutput } from 'sandbox';

import { redact } from './credentials.js';

/** Starts the server's process in the sandbox, streaming its output to `onOutput`. */
export type StartProcess = (
  onOutput: (output: SandboxProcessOutput) => void,
) => Promise<SandboxProcess>;

interface SandboxStdioOptions {
  readonly start: StartProcess;
  /** Masked in all stderr. */
  readonly secrets: readonly string[];
  /**
   * Each complete stderr line, every secret replaced with `[REDACTED]`; of
   * a longer line, `…` and its last 4096 characters.
   */
  readonly onStderr?: (line: string) => void;
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** How much of a longer stderr line is kept: its end, after `…`. */
const STDERR_LINE_MAX = 4096;

/**
 * Where the kept end of `text` starts: `length - keep`, moved back to the
 * start of any secret across it, so a secret is cut out whole or kept whole
 * and is masked either way.
 */
const cutPoint = (
  text: string,
  keep: number,
  secrets: readonly string[],
): number => {
  let cut = text.length - keep;
  let moved = true;

  while (moved) {
    moved = false;

    for (const secret of secrets) {
      if (secret === '') continue;

      const across = text.indexOf(secret, Math.max(0, cut - secret.length + 1));

      if (across !== -1 && across < cut) {
        cut = across;
        moved = true;
      }
    }
  }

  return cut;
};

/**
 * An SDK Transport over a sandbox process. It starts once (a second `start`
 * rejects); `send` writes one message and a newline; each complete stdout
 * line that parses reaches `onmessage`, any other line `onerror`; `close`
 * terminates the process; `onclose` runs once, whether the process was
 * closed or exited on its own. It never shows an unmasked secret.
 */
export const createSandboxStdioTransport = (
  options: SandboxStdioOptions,
): Transport => {
  const stdout = new ReadBuffer();
  /** The unterminated stderr line so far, unmasked; only its end is kept. */
  let stderr = '';
  /** Whether the start of that line was dropped. */
  let cut = false;
  let child: SandboxProcess | undefined;
  let started = false;
  let closed = false;
  // Long enough for the line's kept end and for any secret whole.
  const keep = Math.max(
    STDERR_LINE_MAX,
    ...options.secrets.map((secret) => secret.length),
  );

  const emitStderr = (line: string, dropped = false): void => {
    const raw = line.replace(/\r$/u, '');
    const at =
      raw.length > STDERR_LINE_MAX
        ? cutPoint(raw, STDERR_LINE_MAX, options.secrets)
        : 0;
    const text = redact(raw.slice(at), options.secrets);

    options.onStderr?.(dropped || at > 0 ? `…${text}` : text);
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    // A last line the process left unterminated still reaches the reader.
    if (stderr !== '') emitStderr(stderr, cut);
    stderr = '';
    transport.onclose?.();
  };

  const readStdout = (data: string): void => {
    try {
      stdout.append(Buffer.from(data, 'utf8'));
    } catch (error) {
      transport.onerror?.(asError(error));
      return;
    }

    for (;;) {
      let message: JSONRPCMessage | null;

      try {
        message = stdout.readMessage();
      } catch (error) {
        // The line is consumed: what the server printed is not a message.
        transport.onerror?.(asError(error));
        continue;
      }

      if (message === null) return;
      transport.onmessage?.(message);
    }
  };

  const readStderr = (data: string): void => {
    const lines = (stderr + data).split('\n');
    const rest = lines.pop() ?? '';
    const first = lines.shift();

    if (first !== undefined) {
      emitStderr(first, cut);
      cut = false;
    }

    for (const line of lines) {
      emitStderr(line);
    }

    // A process that never ends its line keeps only the line's end.
    if (rest.length > 2 * keep) {
      const at = cutPoint(rest, keep, options.secrets);
      stderr = rest.slice(at);
      cut ||= at > 0;
    } else {
      stderr = rest;
    }
  };

  const transport: Transport = {
    start: async () => {
      if (started) {
        throw new Error('The sandbox stdio transport is already started.');
      }

      started = true;
      child = await options.start((output) => {
        if (output.stream === 'stdout') readStdout(output.data);
        else readStderr(output.data);
      });
      child.result.then(finish, (error: unknown) => {
        transport.onerror?.(
          new Error(redact(asError(error).message, options.secrets)),
        );
        finish();
      });
    },
    send: async (message) => {
      if (child === undefined || closed) {
        throw new Error('The sandbox stdio transport is not running.');
      }

      await child.write(serializeMessage(message));
    },
    close: async () => {
      if (closed) return;

      try {
        await child?.terminate();
      } finally {
        finish();
      }
    },
  };

  return transport;
};
