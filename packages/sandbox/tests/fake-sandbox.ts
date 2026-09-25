import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { Sandbox, SandboxExecResult } from '../src/index.js';

const run = promisify(execFile);

/**
 * A `Sandbox` over a real temporary directory. Every command the sandbox issues
 * runs for real against that directory, so the visibility rules are exercised
 * against `find` and `sh` rather than against an interpreter of them.
 */
export const createLocalSandbox = (
  localRoot: string,
  root = '/workspace',
): Sandbox => ({
  id: 'local-sandbox',
  root,

  async exec(input) {
    const [command = '', ...args] = input.cmd.map((value) =>
      translate(localRoot, root, value),
    );

    try {
      const output = await run(command, args, {
        cwd: translate(localRoot, root, input.cwd ?? root),
      });

      return result(localRoot, root, output.stdout, 0);
    } catch (error) {
      const failure = error as {
        readonly stdout?: string;
        readonly stderr?: string;
        readonly code?: number;
      };

      return result(
        localRoot,
        root,
        failure.stdout ?? '',
        failure.code ?? 1,
        failure.stderr ?? '',
      );
    }
  },

  readFile(file) {
    return readFile(translate(localRoot, root, file), 'utf8');
  },

  async cloneRepo() {
    throw unsupported();
  },

  async writeFile() {
    throw unsupported();
  },

  async putFile() {
    throw unsupported();
  },

  async getFile() {
    throw unsupported();
  },

  async diff() {
    throw unsupported();
  },

  async ssh() {
    return undefined;
  },
});

/** Rewrites the sandbox root prefix so the command addresses the local tree. */
const translate = (localRoot: string, root: string, value: string): string =>
  value === root
    ? localRoot
    : value.startsWith(`${root}/`)
      ? `${localRoot}${value.slice(root.length)}`
      : value;

const result = (
  localRoot: string,
  root: string,
  stdout: string,
  exitCode: number,
  stderr = '',
): SandboxExecResult => {
  const local = (value: string) => value.split(localRoot).join(root);

  return {
    exitCode,
    stdout: local(stdout),
    stderr: local(stderr),
    stdoutBytes: Buffer.from(stdout),
    stderrBytes: Buffer.from(stderr),
  };
};

const unsupported = (): Error =>
  new Error('Local sandbox method not implemented');
