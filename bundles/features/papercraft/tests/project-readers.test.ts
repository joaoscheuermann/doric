// S57 D1: today's three `files/v1` probes as one port-taking core,
// `projectReaders(files, at)`, over a fake `PapercraftFiles`.
//
// Contract matrix:
// - creating the readers reads nothing;
// - `source`: the text of a plain file, read at the given `ReadAt`; a missing
//   file or a directory answers `undefined`, or rejects `invalid_input` when
//   `strict`; a lease that is not ready, or a truncated or binary file,
//   rejects `invalid_input` with today's texts;
// - `bytes`: the whole file's bytes, else `undefined` (truncated, missing,
//   no lease, a rejected read) — never rejects;
// - `isRepositoryRoot`: `<dir>/.git` (`.git` for `.`) reads as a file or is a
//   directory; missing or a failed read answers `false`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type Call, ContractError } from 'bundle/contracts';

import type { FilesContentRead, LeaseOutcome } from '../src/contracts/index.js';
import { projectReaders } from '../src/host/files.js';
import type {
  BytesReadOutcome,
  PapercraftFiles,
  ReadAt,
} from '../src/host/ports.js';

const call = {
  scope: { projectId: 'p1', threadId: 't1', promptId: 'q1' },
} as unknown as Call;

const at: ReadAt = { projectId: 'p1', call };

/** One fake file: its text, or a directory. */
type Entry =
  | {
      readonly kind: 'file';
      readonly text: string;
      readonly truncated?: boolean;
      readonly binary?: boolean;
    }
  | { readonly kind: 'dir' };

/**
 * `PapercraftFiles` over `entries` under a lease in `status`; `fail` rejects
 * every read. Records each read's path and `ReadAt`.
 */
const filesOf = (
  entries: Readonly<Record<string, Entry>>,
  options: {
    readonly status?: 'ready' | 'pending';
    readonly fail?: boolean;
  } = {},
): PapercraftFiles & { readonly reads: { path: string; at: ReadAt }[] } => {
  const reads: { path: string; at: ReadAt }[] = [];
  const refused = new ContractError('unavailable', 'files/v1 broke');

  const content = (
    path: string,
    where: ReadAt,
  ): Promise<LeaseOutcome<FilesContentRead>> => {
    reads.push({ path, at: where });
    if (options.fail === true) return Promise.reject(refused);
    if (options.status === 'pending')
      return Promise.resolve({ status: 'pending' });

    const entry = entries[path];
    if (entry === undefined) {
      return Promise.resolve({
        status: 'ready',
        value: { status: 'not_found' },
      });
    }
    if (entry.kind === 'dir') {
      return Promise.resolve({
        status: 'ready',
        value: { status: 'not_file' },
      });
    }

    return Promise.resolve({
      status: 'ready',
      value: {
        status: 'read',
        path,
        content: entry.text,
        truncated: entry.truncated ?? false,
        binary: entry.binary ?? false,
      },
    });
  };

  const readBytes = async (
    path: string,
    where: ReadAt,
  ): Promise<LeaseOutcome<BytesReadOutcome>> => {
    const outcome = await content(path, where);
    if (outcome.status !== 'ready') return outcome;
    const value = outcome.value;

    return value.status === 'read'
      ? {
          status: 'ready',
          value: {
            status: 'read',
            bytes: Buffer.from(value.content, 'utf8'),
            truncated: value.truncated,
          },
        }
      : { status: 'ready', value };
  };

  return { reads, content, readBytes };
};

const rejectsInvalidInput = async (
  promise: Promise<unknown>,
  message: string,
): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, message);
    return true;
  });
};

describe('projectReaders', () => {
  test('reads nothing when it is created', () => {
    const files = filesOf({ 'a.ts': { kind: 'file', text: 'a' } });

    projectReaders(files, at);

    assert.deepEqual(files.reads, []);
  });

  describe('source', () => {
    test("answers a plain file's text, read at the readers' ReadAt", async () => {
      const files = filesOf({
        'src/a.ts': { kind: 'file', text: 'export {}' },
      });

      const text = await projectReaders(files, at).source('src/a.ts');

      assert.equal(text, 'export {}');
      assert.deepEqual(files.reads, [{ path: 'src/a.ts', at }]);
    });

    test('answers undefined for a missing file or a directory', async () => {
      const readers = projectReaders(filesOf({ src: { kind: 'dir' } }), at);

      assert.equal(await readers.source('src/missing.ts'), undefined);
      assert.equal(await readers.source('src'), undefined);
    });

    test('rejects invalid_input for a missing file when strict', async () => {
      await rejectsInvalidInput(
        projectReaders(filesOf({}), at).source('src/missing.ts', true),
        'The source "src/missing.ts" could not be read (not_found).',
      );
    });

    test('rejects invalid_input naming the lease state when the sandbox is not ready', async () => {
      await rejectsInvalidInput(
        projectReaders(filesOf({}, { status: 'pending' }), at).source(
          'src/a.ts',
        ),
        'The Project sandbox is not ready to read "src/a.ts" (pending).',
      );
    });

    test('rejects invalid_input for a truncated or binary file', async () => {
      const readers = projectReaders(
        filesOf({
          'big.ts': { kind: 'file', text: 'x', truncated: true },
          'logo.ts': { kind: 'file', text: 'x', binary: true },
        }),
        at,
      );

      await rejectsInvalidInput(
        readers.source('big.ts'),
        'The source "big.ts" is not previewable plain text.',
      );
      await rejectsInvalidInput(
        readers.source('logo.ts'),
        'The source "logo.ts" is not previewable plain text.',
      );
    });
  });

  describe('bytes', () => {
    test("answers the whole file's bytes", async () => {
      const files = filesOf({ 'font.woff2': { kind: 'file', text: 'woff' } });

      const bytes = await projectReaders(files, at).bytes('font.woff2');

      assert.deepEqual(
        bytes === undefined ? undefined : Buffer.from(bytes),
        Buffer.from('woff', 'utf8'),
      );
      assert.ok(files.reads.length > 0, 'the bytes are read');
      for (const read of files.reads) assert.deepEqual(read.at, at);
    });

    test('answers undefined for a truncated, missing or unreadable file', async () => {
      const truncated = filesOf({
        'big.png': { kind: 'file', text: 'x', truncated: true },
      });

      assert.equal(
        await projectReaders(truncated, at).bytes('big.png'),
        undefined,
      );
      assert.equal(
        await projectReaders(filesOf({}), at).bytes('x.png'),
        undefined,
      );
      assert.equal(
        await projectReaders(filesOf({}, { status: 'pending' }), at).bytes(
          'x.png',
        ),
        undefined,
      );
      assert.equal(
        await projectReaders(filesOf({}, { fail: true }), at).bytes('x.png'),
        undefined,
      );
    });
  });

  describe('isRepositoryRoot', () => {
    test('answers true when <dir>/.git is a file or a directory', async () => {
      const readers = projectReaders(
        filesOf({
          '.git': { kind: 'dir' },
          'apps/web/.git': {
            kind: 'file',
            text: 'gitdir: ../../.git/worktrees/web',
          },
        }),
        at,
      );

      assert.equal(await readers.isRepositoryRoot('.'), true);
      assert.equal(await readers.isRepositoryRoot('apps/web'), true);
    });

    test('answers false when <dir>/.git is missing or the read fails', async () => {
      assert.equal(
        await projectReaders(filesOf({}), at).isRepositoryRoot('apps'),
        false,
      );
      assert.equal(
        await projectReaders(filesOf({}, { fail: true }), at).isRepositoryRoot(
          '.',
        ),
        false,
      );
    });
  });
});
