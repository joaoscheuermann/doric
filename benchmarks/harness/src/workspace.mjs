import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const sensitive = /key|token|secret|password|credential|authorization|cookie/iu;

/** Bind core tools to the task container, never to a newly created Docker sandbox. */
export const workspace = (root, signal) => ({
  root,
  readFile: (path) => readFile(resolve(root, path), 'utf8'),
  writeFile: async (path, content) => {
    const target = resolve(root, path);

    signal?.throwIfAborted();

    await mkdir(dirname(target), { recursive: true });

    await writeFile(target, content);
  },
  exec: ({ cmd, cwd = root, timeoutMs = 120_000 }) =>
    execute({ cmd, cwd, timeoutMs, signal }),
});

const execute = ({ cmd, cwd, timeoutMs, signal }) =>
  new Promise((resolveResult, reject) => {
    signal?.throwIfAborted();

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !sensitive.test(key)),
    );

    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let stopped;

    const stop = (reason) => {
      stopped = reason;

      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    };

    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed out'), timeoutMs);

    signal?.addEventListener('abort', abort, { once: true });

    if (signal?.aborted) {
      abort();
    }

    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (data) => {
        const available = Math.max(0, 4 * 1024 * 1024 - sizes[stream]);

        chunks[stream].push(data.subarray(0, available));

        sizes[stream] += data.length;

        if (sizes[stream] > 4 * 1024 * 1024) {
          stop('output limit exceeded');
        }
      });
    }

    const cleanup = () => {
      clearTimeout(timer);

      signal?.removeEventListener('abort', abort);
    };

    child.once('error', (error) => {
      cleanup();

      reject(error);
    });

    child.once('close', (code) => {
      cleanup();

      const stdoutBytes = Buffer.concat(chunks.stdout);
      const stderrBytes = Buffer.concat(chunks.stderr);

      resolveResult({
        exitCode: stopped ? 124 : (code ?? 1),
        stdout: stdoutBytes.toString(),
        stderr:
          stderrBytes.toString() + (stopped ? '\nCommand ' + stopped : ''),
        stdoutBytes,
        stderrBytes,
      });
    });
  });
