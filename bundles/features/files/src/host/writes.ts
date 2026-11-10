// files/v1@1.2.0 (ui-redesign §4.4, HC-007): New file and New folder. One
// single-segment name in an existing workspace directory, never an overwrite:
// the entry is made by one command that fails when the name exists, so no
// check-then-create race can replace anything. `sandbox.writeFile` is not used
// (it runs `mkdir -p` and overwrites).

import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { type Sandbox, workspacePathKind } from 'sandbox';

import type { CreateInput, CreateOutcome } from '../contracts/index.js';

/** The longest name a file system takes, in UTF-8 bytes. */
const NAME_LIMIT_BYTES = 255;

const validName = (name: string): boolean =>
  name !== '' &&
  name !== '.' &&
  name !== '..' &&
  !/[/\\\0]/.test(name) &&
  Buffer.byteLength(name, 'utf8') <= NAME_LIMIT_BYTES;

/** Creates an empty file or directory named `input.name` in `input.directory`. */
export const createEntry = async (
  sandbox: Sandbox,
  input: CreateInput,
  kind: 'file' | 'directory',
): Promise<CreateOutcome> => {
  if (!validName(input.name))
    return { status: 'refused', reason: 'invalid-name' };

  const directory = await workspacePathKind(sandbox, input.directory);
  if (directory === 'escaped') return { status: 'refused', reason: 'outside' };
  if (directory !== 'directory')
    return { status: 'refused', reason: 'no-directory' };

  // The resolution `workspacePathKind` applies: an absolute directory is not
  // joined under the root a second time.
  const base = posix.isAbsolute(input.directory)
    ? posix.normalize(input.directory)
    : posix.join(sandbox.root, input.directory);
  const path = posix.join(base, input.name);

  const made = await sandbox.exec({
    cmd:
      kind === 'file'
        ? // noclobber opens with O_EXCL: an existing name fails the command.
          ['sh', '-c', 'set -C; : > "$1"', 'sh', path]
        : ['mkdir', '--', path],
  });
  if (made.exitCode === 0)
    return { status: 'created', path: posix.relative(sandbox.root, path) };

  const exists = await sandbox.exec({
    cmd: ['sh', '-c', '[ -e "$1" ] || [ -L "$1" ]', 'sh', path],
  });
  if (exists.exitCode === 0) return { status: 'refused', reason: 'exists' };

  return { status: 'failed', message: firstLine(made.stderr) };
};

const firstLine = (text: string): string =>
  text.split('\n').find((line) => line.trim() !== '') ?? '';
