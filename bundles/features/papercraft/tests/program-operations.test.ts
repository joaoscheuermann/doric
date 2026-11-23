// S57 D1, D2: `createProgramOperations(files, deps)`, the programs host
// without a service definition, over a fake `PapercraftFiles` and a job
// runner whose sandbox cannot bundle (so exports compile on the host).
//
// Contract matrix:
// - `library`: `invalid_scope` without a Thread scope; `none` when
//   `deps.cwdAt` finds no binding, asked with the call's Project and Thread;
// - `export`: a path leaving the Project answers `failed`; the source is read
//   with the call (`ReadAt {projectId, call}`); a ready export's module is
//   then listed by `moduleFiles` — `<dir>/<file>` paths in path order, each
//   `sha256` that of its bytes — in that Project only; a `deps.native` that
//   cannot load esbuild answers `failed` naming it;
// - `moduleFiles`: `invalid_scope` without a Thread scope; `not_found` "No
//   module <dir> is in the host memo." for an unknown `dir`.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { type Call, ContractError } from 'bundle/contracts';

import type { FilesContentRead, LeaseOutcome } from '../src/contracts/index.js';
import type { NativePackages } from '../src/host/native.js';
import type {
  BytesReadOutcome,
  PapercraftFiles,
  ReadAt,
} from '../src/host/ports.js';
import {
  createProgramOperations,
  type ProgramsDeps,
} from '../src/host/programs.js';

const callIn = (projectId: string, threadId?: string): Call =>
  ({
    scope: {
      projectId,
      ...(threadId === undefined ? {} : { threadId }),
      promptId: 'q1',
    },
  }) as unknown as Call;

const call = callIn('p1', 't1');

const SOURCE = [
  'export default function Hello() {',
  '  return <p className="p-4">hello</p>;',
  '}',
].join('\n');

/** `PapercraftFiles` over one Project's text files, recording each read's `ReadAt`. */
const filesOf = (
  entries: Readonly<Record<string, string>>,
): PapercraftFiles & { readonly reads: { path: string; at: ReadAt }[] } => {
  const reads: { path: string; at: ReadAt }[] = [];

  const content = (
    path: string,
    at: ReadAt,
  ): Promise<LeaseOutcome<FilesContentRead>> => {
    reads.push({ path, at });
    const text = entries[path];

    return Promise.resolve(
      text === undefined
        ? { status: 'ready', value: { status: 'not_found' } }
        : {
            status: 'ready',
            value: {
              status: 'read',
              path,
              content: text,
              truncated: false,
              binary: false,
            },
          },
    );
  };

  const readBytes = async (
    path: string,
    at: ReadAt,
  ): Promise<LeaseOutcome<BytesReadOutcome>> => {
    const outcome = await content(path, at);
    if (outcome.status !== 'ready') return outcome;

    return outcome.value.status === 'read'
      ? {
          status: 'ready',
          value: {
            status: 'read',
            bytes: Buffer.from(outcome.value.content, 'utf8'),
            truncated: false,
          },
        }
      : { status: 'ready', value: outcome.value };
  };

  return { reads, content, readBytes };
};

/** Deps whose sandbox cannot run a job; `cwdAt` answers `cwd` and records its questions. */
const depsOf = (
  options: { readonly cwd?: string; readonly native?: NativePackages } = {},
): ProgramsDeps & { readonly asked: unknown[] } => {
  const asked: unknown[] = [];

  return {
    asked,
    runJob: () =>
      Promise.resolve({ status: 'unavailable', reason: 'no sandbox here' }),
    cwdAt: (scope, turnSequence) => {
      asked.push({ scope, turnSequence });
      return Promise.resolve(options.cwd);
    },
    ...(options.native === undefined ? {} : { native: options.native }),
  };
};

const isContractError =
  (code: string, message?: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    if (message !== undefined) assert.equal(error.message, message);
    return true;
  };

const SCOPE_MESSAGE =
  'papercraft.programs/v1 needs a Project and Thread scope.';

describe('createProgramOperations', () => {
  describe('library', () => {
    test('rejects invalid_scope without a Thread in the call scope', async () => {
      const operations = createProgramOperations(filesOf({}), depsOf());

      await assert.rejects(
        operations.library({ turnSequence: 3 }, callIn('p1')),
        isContractError('invalid_scope', SCOPE_MESSAGE),
      );
    });

    test("answers none when no cwd is bound, asking cwdAt with the call's Project and Thread", async () => {
      const deps = depsOf();
      const operations = createProgramOperations(filesOf({}), deps);

      const answer = await operations.library({ turnSequence: 4 }, call);

      assert.deepEqual(answer, { status: 'none' });
      assert.deepEqual(deps.asked, [
        { scope: { projectId: 'p1', threadId: 't1' }, turnSequence: 4 },
      ]);
    });
  });

  describe('export', () => {
    test('answers failed for a path that leaves the Project', async () => {
      const operations = createProgramOperations(filesOf({}), depsOf());

      const answer = await operations.export({ path: '../outside.tsx' }, call);

      assert.deepEqual(answer, {
        status: 'failed',
        error: 'The path leaves the Project',
      });
    });

    test("reads the source with the call and lists the module's files in that Project", async () => {
      const files = filesOf({ 'src/Hello.tsx': SOURCE });
      const operations = createProgramOperations(files, depsOf());

      const answer = await operations.export({ path: 'src/Hello.tsx' }, call);

      assert.equal(answer.status, 'ready', JSON.stringify(answer));
      assert.ok(answer.status === 'ready');
      assert.deepEqual(
        files.reads.find((read) => read.path === 'src/Hello.tsx')?.at,
        { projectId: 'p1', call },
      );

      const dir = answer.module.dir;
      const listed = operations.moduleFiles(dir, call);

      assert.ok(listed.length > 0, 'the module has files');
      assert.deepEqual(
        listed.map((file) => file.path),
        listed.map((file) => file.path).sort(),
      );
      for (const file of listed) {
        assert.ok(file.path.startsWith(`${dir}/`), file.path);
        assert.equal(
          file.sha256,
          createHash('sha256').update(file.bytes).digest('hex'),
        );
      }
      assert.throws(
        () => operations.moduleFiles(dir, callIn('p2', 't1')),
        isContractError('not_found', `No module ${dir} is in the host memo.`),
      );
    });

    test('answers failed naming esbuild when deps.native cannot load it', async () => {
      const native: NativePackages = {
        esbuild: () => {
          throw new Error("Cannot find module 'esbuild'");
        },
        tailwind: () => {
          throw new Error("Cannot find module 'tailwindcss'");
        },
      };
      const operations = createProgramOperations(
        filesOf({ 'src/Hello.tsx': SOURCE }),
        depsOf({ native }),
      );

      const answer = await operations.export({ path: 'src/Hello.tsx' }, call);

      assert.equal(answer.status, 'failed');
      assert.ok(answer.status === 'failed');
      assert.match(answer.error, /Cannot find module 'esbuild'/u);
    });
  });

  describe('moduleFiles', () => {
    test('throws invalid_scope without a Thread in the call scope', () => {
      const operations = createProgramOperations(filesOf({}), depsOf());

      assert.throws(
        () => operations.moduleFiles('m-1', callIn('p1')),
        isContractError('invalid_scope', SCOPE_MESSAGE),
      );
    });

    test('throws not_found for a module the memo does not hold', () => {
      const operations = createProgramOperations(filesOf({}), depsOf());

      assert.throws(
        () => operations.moduleFiles('m-unknown', call),
        isContractError(
          'not_found',
          'No module m-unknown is in the host memo.',
        ),
      );
    });
  });
});
