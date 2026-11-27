// Shared fixtures of the `files/v1` router tests (router-files.test.ts,
// reads.test.ts and write-entry.test.ts, slice S53b): a workspace sandbox
// whose bounded read and create commands run for real, the part activated
// over it, and the answers as JSON.

import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

import { type JsonValue, toJson } from '@bufbuild/protobuf';
import type { Sandbox, SandboxExecInput, SandboxExecResult } from 'sandbox';

import {
  type ReadBytesResponse,
  ReadBytesResponseSchema,
} from '../../src/contracts/gen/doric/files/v1/files_pb.js';
import {
  createFakeSandbox,
  fakeHost,
  WORKSPACE_ROOT,
} from '../fake-sandbox.js';
import type { Harness } from './router.js';
import { activated } from './router-fixtures.js';

const run = promisify(execFile);

/** A name whose create the sandbox fails, as a read-only file system would. */
export const READ_ONLY_NAME = 'readonly-entry';

/** The commands of `readContent` and `createEntry` the fake sandbox does not model. */
const runsForReal = (cmd: readonly string[]): boolean =>
  cmd[0] === 'head' ||
  cmd[0] === 'mkdir' ||
  (cmd[0] === 'sh' &&
    (cmd[2] === 'set -C; : > "$1"' || cmd[2] === '[ -e "$1" ] || [ -L "$1" ]'));

const outcome = (
  exitCode: number,
  stdout: Buffer,
  stderr: Buffer,
): SandboxExecResult => ({
  exitCode,
  stdout: stdout.toString('utf8'),
  stderr: stderr.toString('utf8'),
  stdoutBytes: stdout,
  stderrBytes: stderr,
});

/**
 * The fake sandbox (`createFakeSandbox`) over `localRoot` (listings, kind
 * probes, file bytes), where `head -c`, `mkdir` and the create and existence checks run
 * for real with `/workspace` paths mapped onto `localRoot`. A create of
 * {@link READ_ONLY_NAME} fails with a read-only file system's message.
 */
export const commandSandbox = (localRoot: string): Sandbox => {
  const base = createFakeSandbox(localRoot);
  const local = (value: string): string =>
    value === WORKSPACE_ROOT || value.startsWith(`${WORKSPACE_ROOT}/`)
      ? path.join(localRoot, value.slice(WORKSPACE_ROOT.length))
      : value;

  return {
    ...base,
    exec: async (input: SandboxExecInput) => {
      if (!runsForReal(input.cmd)) return base.exec(input);
      if (
        input.cmd[0] !== 'head' &&
        input.cmd[2] !== '[ -e "$1" ] || [ -L "$1" ]' &&
        input.cmd.at(-1)?.endsWith(`/${READ_ONLY_NAME}`)
      ) {
        return outcome(
          1,
          Buffer.alloc(0),
          Buffer.from(
            `cannot create ${input.cmd.at(-1)}: Read-only file system\n`,
          ),
        );
      }
      const [command = '', ...args] = input.cmd.map(local);
      try {
        const done = await run(command, args, {
          cwd: localRoot,
          encoding: 'buffer',
          maxBuffer: 64 * 1024 * 1024,
        });
        return outcome(0, done.stdout, done.stderr);
      } catch (error) {
        const failed = error as {
          code?: number;
          stdout?: Buffer;
          stderr?: Buffer;
        };
        return outcome(
          typeof failed.code === 'number' ? failed.code : 1,
          failed.stdout ?? Buffer.alloc(0),
          failed.stderr ?? Buffer.alloc(0),
        );
      }
    },
  };
};

/** The part activated over a {@link commandSandbox} of `root`. */
export const filesPart = (t: TestContext, root: string): Promise<Harness> =>
  activated(t, {
    sandbox: commandSandbox(root),
    host: fakeHost({ localRoot: root }),
  });

/** Every item of a `ReadBytes` stream, in order. */
export const itemsOf = async (
  stream: AsyncIterable<ReadBytesResponse>,
): Promise<ReadBytesResponse[]> => {
  const items: ReadBytesResponse[] = [];
  for await (const item of stream) items.push(item);
  return items;
};

/** The `ReadBytes` items as JSON: the head's, then each chunk's length. */
export const itemsJson = (items: readonly ReadBytesResponse[]): JsonValue[] =>
  items.map((item) =>
    item.item.case === 'chunk'
      ? { chunk: item.item.value.length }
      : toJson(ReadBytesResponseSchema, item),
  );

/** The bytes of the `ReadBytes` chunks, joined in order. */
export const bytesOf = (items: readonly ReadBytesResponse[]): Buffer =>
  Buffer.concat(
    items.flatMap((item) =>
      item.item.case === 'chunk' ? [Buffer.from(item.item.value)] : [],
    ),
  );

/** The non-ready lease states, each an answer of every `files/v1` method. */
export const NOT_READY = [
  'pending',
  'unavailable',
  'expired',
  'missing',
] as const;
