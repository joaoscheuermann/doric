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
  /** Each complete stderr line, every secret replaced with `[REDACTED]`. */
  readonly onStderr?: (line: string) => void;
}

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

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
  let stderr = '';
  let child: SandboxProcess | undefined;
  let started = false;
  let closed = false;

  const emitStderr = (line: string): void =>
    options.onStderr?.(redact(line.replace(/\r$/u, ''), options.secrets));

  const finish = (): void => {
    if (closed) return;
    closed = true;
    // A last line the process left unterminated still reaches the reader.
    if (stderr !== '') emitStderr(stderr);
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
    stderr = lines.pop() ?? '';

    for (const line of lines) {
      emitStderr(line);
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
