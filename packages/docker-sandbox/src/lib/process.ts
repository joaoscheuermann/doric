import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  captureProcessOutput,
  processTerminationScript,
  type SandboxProcess,
  type SandboxProcessInput,
} from 'sandbox';

import { containerId, execCreateBody, socketPath } from './mapping.js';
import type {
  ContainerRef,
  DockerClient,
  DockerConnection,
  DockerTransportRequest,
} from './types/docker.js';

type JsonRequest = (
  request: DockerTransportRequest,
  status: number,
) => Promise<Record<string, unknown>>;

/** Attaches to an Engine exec through its duplex HTTP upgrade. */
export const startDockerProcess = async (
  client: DockerClient,
  connection: DockerConnection,
  json: JsonRequest,
  container: ContainerRef | string,
  input: SandboxProcessInput,
): Promise<SandboxProcess> => {
  input.signal?.throwIfAborted();
  if (input.cmd.length === 0)
    throw new Error('Sandbox command must not be empty');
  const pidFile = `/tmp/doric-process-${randomUUID()}`;
  const created = await json(
    {
      method: 'POST',
      path: `/containers/${encodeURIComponent(containerId(container))}/exec`,
      body: {
        ...execCreateBody({
          ...input,
          workingDir: input.cwd,
          cmd: [
            ...(input.tty ? [] : ['setsid', '-w']),
            'sh',
            '-c',
            `echo $$ > '${pidFile}'; exec "$@"`,
            'doric',
            ...input.cmd,
          ],
        }),
        AttachStdin: true,
        ...(input.tty
          ? { ConsoleSize: [input.rows ?? 24, input.cols ?? 80] }
          : {}),
      },
      signal: input.signal,
    },
    201,
  );
  if (typeof created.Id !== 'string')
    throw new Error('Docker did not return an exec ID');
  const id = created.Id;
  const stream = await attach(
    connection,
    id,
    input.tty === true,
    input.signal,
  ).catch(async (cause: unknown) => {
    await client
      .exec(container, {
        cmd: ['sh', '-c', processTerminationScript(pidFile)],
        timeoutMs: 5_000,
      })
      .catch(() => undefined);
    throw cause;
  });
  const capture = captureProcessOutput(input);
  let pending = Buffer.alloc(0);
  let finished = false;
  let failing = false;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): Promise<void> => {
    if (finished) return Promise.resolve();
    stopping ??= client
      .exec(container, {
        cmd: [
          'sh',
          '-c',
          `i=0; while [ ! -r '${pidFile}' ] && [ "$i" -lt 100 ]; do sleep 0.01; i=$((i+1)); done; ${processTerminationScript(pidFile)}`,
        ],
        timeoutMs: 5_000,
      })
      .then((result) => {
        if (result.exitCode !== 0)
          throw new Error('Could not terminate sandbox process');
      });
    return stopping;
  };
  const abort = () => {
    void terminate().catch(() =>
      stream.destroy(new Error('Sandbox process termination failed')),
    );
  };
  const result = new Promise<Awaited<SandboxProcess['result']>>(
    (resolve, reject) => {
      const cleanup = () => {
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
      };
      stream.on('data', (chunk: Buffer) => {
        if (input.tty) {
          capture.append('stdout', chunk);
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 8) {
          const length = pending.readUInt32BE(4);
          if (length > 16_777_216) {
            stream.destroy(new Error('Invalid Docker output frame'));
            return;
          }
          if (pending.length < 8 + length) break;
          capture.append(
            pending[0] === 2 ? 'stderr' : 'stdout',
            pending.subarray(8, 8 + length),
          );
          pending = pending.subarray(8 + length);
        }
      });
      const fail = (cause: Error) => {
        if (failing || finished) return;
        failing = true;
        void terminate()
          .finally(() => {
            cleanup();
            reject(
              cause instanceof Error
                ? cause
                : new Error('Docker process inspection failed', { cause }),
            );
          })
          .catch(() => undefined);
      };
      stream.once('error', fail);
      stream.once('close', () => {
        if (!stream.readableEnded)
          fail(new Error('Docker process stream closed unexpectedly'));
      });
      stream.once('end', () => {
        void waitForExit(json, id).then(
          async (inspect) => {
            await client
              .exec(container, { cmd: ['rm', '-f', pidFile], timeoutMs: 5_000 })
              .catch(() => undefined);
            cleanup();
            resolve(
              capture.finish(
                typeof inspect.ExitCode === 'number' ? inspect.ExitCode : null,
              ),
            );
          },
          (cause: unknown) => {
            cleanup();
            reject(
              cause instanceof Error
                ? cause
                : new Error('Docker process inspection failed', { cause }),
            );
          },
        );
      });
    },
  );
  // The caller may not attach its result handler until after the opening handshake.
  void result.catch(() => undefined);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  if (input.timeoutMs !== undefined) timer = setTimeout(abort, input.timeoutMs);
  return {
    result,
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        if (finished || stream.destroyed) {
          reject(new Error('Sandbox process has exited'));
          return;
        }
        stream.write(data, (cause) => (cause ? reject(cause) : resolve()));
      }),
    async resize(cols, rows) {
      if (!input.tty || finished) return;
      if (
        !Number.isInteger(cols) ||
        !Number.isInteger(rows) ||
        cols < 1 ||
        rows < 1
      )
        throw new RangeError('Terminal dimensions must be positive integers');
      await json(
        {
          method: 'POST',
          path: `/exec/${encodeURIComponent(id)}/resize`,
          query: { h: rows, w: cols },
        },
        200,
      );
    },
    terminate,
  };
};

const waitForExit = async (
  json: JsonRequest,
  id: string,
): Promise<Record<string, unknown>> => {
  for (;;) {
    const inspect = await json(
      { method: 'GET', path: `/exec/${encodeURIComponent(id)}/json` },
      200,
    );
    if (inspect.Running !== true) return inspect;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const attach = (
  connection: DockerConnection,
  id: string,
  tty: boolean,
  signal?: AbortSignal,
): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: tty });
    const client = request({
      socketPath: socketPath(connection),
      path: `/exec/${encodeURIComponent(id)}/start`,
      method: 'POST',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'tcp',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    const abort = () =>
      client.destroy(new Error('Docker process opening aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    client.once('close', () => signal?.removeEventListener('abort', abort));
    client.once('error', reject);
    client.once('upgrade', (response, socket, head) => {
      signal?.removeEventListener('abort', abort);
      if (response.statusCode !== 101) {
        socket.destroy();
        reject(new Error('Docker exec upgrade failed'));
        return;
      }
      // Pause until startDockerProcess has installed its output listeners.
      socket.pause();
      socket.setTimeout(0);
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
      queueMicrotask(() => socket.resume());
    });
    client.once('response', (response) => {
      response.resume();
      reject(new Error(`Docker exec upgrade failed (${response.statusCode})`));
    });
    client.setTimeout(10_000, () =>
      client.destroy(new Error('Docker exec opening timed out')),
    );
    client.end(body);
    if (signal?.aborted) abort();
  });
