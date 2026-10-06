import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import {
  captureProcessOutput,
  processTerminationScript,
  quote,
  type SandboxExecInput,
  type SandboxExecResult,
  type SandboxProcess,
  type SandboxProcessInput,
} from 'sandbox';

interface Connection {
  readonly host: string;
  readonly privateKeyPath: string;
  readonly knownHostsPath: string;
  readonly env: readonly string[];
  readonly user: string;
}

/** A live guest command owns its remote session independently of SSH. */
export const startGuestProcess = async (
  connection: Connection,
  input: SandboxProcessInput,
  exec: (input: SandboxExecInput) => Promise<SandboxExecResult>,
): Promise<SandboxProcess> => {
  input.signal?.throwIfAborted();
  if (input.cmd.length === 0)
    throw new Error('Sandbox command must not be empty');
  const pidFile = `/tmp/doric-process-${randomUUID()}`;
  const ttyFile = `${pidFile}.tty`;
  const env = new Map(
    [...connection.env, ...(input.env ?? [])].map((item) => [
      item.slice(0, item.indexOf('=')),
      item,
    ]),
  );
  const setup = `echo $$ > ${quote(pidFile)}; ${input.tty ? `tty > ${quote(ttyFile)}; stty cols ${input.cols ?? 80} rows ${input.rows ?? 24};` : ''} exec "$@"`;
  const argv = [
    ...(input.tty ? [] : ['setsid', '-w']),
    'sh',
    '-c',
    setup,
    'doric',
    ...input.cmd,
  ];
  const script = `cd ${quote(input.cwd ?? '/workspace')} && exec /.doric/bin/busybox env ${[...env.values()].map(quote).join(' ')} ${argv.map(quote).join(' ')}`;
  const user = input.user ?? connection.user;
  const remote = ['', 'root', '0', '0:0'].includes(user)
    ? script
    : `/.doric/bin/busybox su -s /.doric/bin/sh ${quote(user.split(':')[0] ?? user)} -c ${quote(script)}`;
  const child = spawn(
    'ssh',
    [
      input.tty ? '-tt' : '-T',
      '-i',
      connection.privateKeyPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${connection.knownHostsPath}`,
      '-o',
      'ConnectTimeout=2',
      `root@${connection.host}`,
      remote,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const capture = captureProcessOutput(input);
  let finished = false;
  let stopping: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): Promise<void> => {
    if (finished) return Promise.resolve();
    stopping ??= exec({
      cmd: [
        'sh',
        '-c',
        `i=0; while [ ! -r ${quote(pidFile)} ] && [ "$i" -lt 100 ]; do sleep 0.01; i=$((i+1)); done; ${processTerminationScript(pidFile)}; rm -f ${quote(ttyFile)}`,
      ],
      user: 'root',
      timeoutMs: 5_000,
    }).then((result) => {
      if (result.exitCode !== 0)
        throw new Error('Could not terminate guest process');
    });
    return stopping;
  };
  const abort = () => {
    void terminate().catch(() => child.kill('SIGKILL'));
  };
  const result = new Promise<SandboxExecResult>((resolve, reject) => {
    const cleanup = () => {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', (chunk: Buffer) => capture.append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => capture.append('stderr', chunk));
    child.once('error', () => {
      cleanup();
      reject(new Error('Firecracker management SSH could not start'));
    });
    child.once('close', (code) => {
      void (async () => {
        // SSH reserves 255 for channel/connection failures: remote jobs can survive it.
        if (code === 255 || code === null) await terminate();
        await exec({
          cmd: ['rm', '-f', pidFile, ttyFile],
          user: 'root',
          timeoutMs: 5_000,
        }).catch(() => undefined);
        cleanup();
        resolve(capture.finish(code));
      })().catch((cause: unknown) => {
        cleanup();
        reject(
          cause instanceof Error
            ? cause
            : new Error('Guest process cleanup failed', { cause }),
        );
      });
    });
  });
  void result.catch(() => undefined);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  if (input.timeoutMs !== undefined) timer = setTimeout(abort, input.timeoutMs);
  await once(child, 'spawn');
  return {
    result,
    write: (data) =>
      new Promise<void>((resolve, reject) => {
        if (finished) {
          reject(new Error('Sandbox process has exited'));
          return;
        }
        child.stdin.write(data, (cause) => (cause ? reject(cause) : resolve()));
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
      const result = await exec({
        cmd: [
          'sh',
          '-c',
          `stty cols ${cols} rows ${rows} < "$(cat ${quote(ttyFile)})"`,
        ],
        user: 'root',
        timeoutMs: 5_000,
      });
      if (result.exitCode !== 0)
        throw new Error('Could not resize guest terminal');
    },
    terminate,
  };
};
