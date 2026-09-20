import { type ChildProcess, spawn } from 'node:child_process';
import { basename } from 'node:path';

export type CommandInput = {
  readonly file: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type CommandResult = {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

/** Runs one host command without a shell and without exposing its payload in errors. */
export const run = (input: CommandInput): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(input.file, [...(input.args ?? [])], {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    let timedOut = false;
    let settled = false;
    const abort = () => child.kill('SIGKILL');

    const timer =
      input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;

            abort();
          }, input.timeoutMs);

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      input.signal?.removeEventListener('abort', abort);
    };

    const fail = (cause: Error) => {
      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      reject(cause);
    };

    child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));

    child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));

    child.once('error', () =>
      fail(
        new Error(
          `Firecracker host command could not start: ${basename(input.file)}`,
        ),
      ),
    );

    child.once('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;

      cleanup();

      if (timedOut) {
        reject(
          new Error(
            `Firecracker host command timed out: ${basename(input.file)}`,
          ),
        );

        return;
      }

      if (input.signal?.aborted) {
        reject(
          Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          }),
        );

        return;
      }

      if (code !== 0) {
        reject(
          new Error(`Firecracker host command failed: ${basename(input.file)}`),
        );

        return;
      }

      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });

    if (input.signal?.aborted) {
      abort();

      return;
    }

    input.signal?.addEventListener('abort', abort, { once: true });

    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });

export const start = (input: CommandInput): ChildProcess =>
  spawn(input.file, [...(input.args ?? [])], {
    cwd: input.cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });

export const text = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('utf8');
