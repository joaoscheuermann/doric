// A bundle's process as the supervisor tracks it (spec
// `docs/designs/grpc-processes.md`, section 7, "Supervision"): until it
// exits, how it exited, and the timed wait for that exit.

import type { ChildProcess } from 'node:child_process';

import type { InstanceKey } from '../router/instances.js';

/** A spawned process, tracked until it exits. */
export interface BundleProcess {
  readonly bundleId: string;
  readonly key: InstanceKey;
  readonly child: ChildProcess;
  /** Resolves when the process has exited, or could not start. */
  readonly exit: Promise<void>;
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  /** The spawn error, when the process could not start. */
  error?: string;
  /** Called once when the process exits, while its Hello is awaited. */
  onExit: (() => void) | undefined;
}

export const trackProcess = (
  bundleId: string,
  key: InstanceKey,
  child: ChildProcess,
): BundleProcess => {
  let markExited: () => void = () => {};
  const bundleProcess: BundleProcess = {
    bundleId,
    key,
    child,
    exit: new Promise<void>((resolve) => {
      markExited = resolve;
    }),
    exited: false,
    exitCode: null,
    signal: null,
    onExit: undefined,
  };
  const ended = (): void => {
    if (bundleProcess.exited) {
      return;
    }

    bundleProcess.exited = true;
    markExited();
    bundleProcess.onExit?.();
  };

  // Drained so a chatty bundle never blocks on a full pipe.
  child.stdout?.resume();
  child.stderr?.resume();
  child.on('exit', (code, signal) => {
    bundleProcess.exitCode = code;
    bundleProcess.signal = signal;
    ended();
  });
  child.on('error', (error) => {
    if (child.pid === undefined) {
      bundleProcess.error = error.message;
      ended();
    }
  });

  return bundleProcess;
};

export const exitOf = (bundleProcess: BundleProcess): string =>
  bundleProcess.error ??
  (bundleProcess.signal === null
    ? `exit code ${bundleProcess.exitCode ?? 'unknown'}`
    : `signal ${bundleProcess.signal}`);

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Resolves when `promise` settles or after `ms`, whichever comes first. */
export const within = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;

  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
};

/** Sends `SIGKILL` to a process that has not exited. */
export const kill = (bundleProcess: BundleProcess): void => {
  if (!bundleProcess.exited) {
    bundleProcess.child.kill('SIGKILL');
  }
};
