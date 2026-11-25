// files/v1 (stage 10, §3.6) and the window's reads over it: the Project
// sandbox reads of the file panel and the file tab, host side through the
// part's real `FilesService` over the router (`./support/router.js`, with its
// fake `runtime.lease/v1`), window side through the client part's
// `filesReadsOf` over the generated `FilesService` client (slice S65d), which
// is observed as the REST client answered: lease states and refusals are
// data, `pending` carries `Retry-After: 1`, a failed call is a sentence.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { toJson } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';

import { filesReadsOf } from '../src/client/api/reads.js';
import { filesWritesOf } from '../src/client/api/writes.js';
import {
  ContentResponseSchema,
  DirectoriesResponseSchema,
  DirectoryResponseSchema,
  FilesService,
  TreeResponseSchema,
} from '../src/contracts/gen/doric/files/v1/files_pb.js';
import { CONTENT_LIMIT_BYTES } from '../src/host/reads.js';
import { filesWindow } from './support/files-connect.js';
import { filesPart, NOT_READY } from './support/router-files.js';
import { workspace } from './support/router-fixtures.js';

/** The workspace every case reads, unless it names its own. */
const FILES = {
  'README.md': 'hello',
  'src/a.ts': 'export const a = 1;\n',
  'src/deep/b.ts': 'b',
  'image.bin': Uint8Array.from([0x89, 0x50, 0x00, 0x47]),
  'big.txt': 'x'.repeat(CONTENT_LIMIT_BYTES + 10),
} as const;

describe('files/v1 over the Project lease', () => {
  test('lists the whole tree below a directory, and one level of it', async (t) => {
    const root = await workspace(t, FILES);
    const h = await filesPart(t, root);
    const files = h.files({ projectId: 'p-1' });

    assert.deepEqual(
      toJson(TreeResponseSchema, await files.tree({ path: 'src' })),
      {
        status: 'ready',
        value: {
          status: 'listed',
          path: 'src',
          entries: [
            {
              name: 'deep',
              path: 'src/deep',
              type: 'directory',
              children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
            },
            { name: 'a.ts', path: 'src/a.ts', type: 'file' },
          ],
        },
      },
    );
    assert.deepEqual(
      toJson(DirectoryResponseSchema, await files.directory({ path: 'src' })),
      {
        status: 'ready',
        value: {
          status: 'listed',
          path: 'src',
          entries: [
            { name: 'deep', path: 'src/deep', type: 'directory' },
            { name: 'a.ts', path: 'src/a.ts', type: 'file' },
          ],
        },
      },
    );
  });

  test('lists several directories one level each, in the order asked', async (t) => {
    const root = await workspace(t, FILES);
    const h = await filesPart(t, root);

    assert.deepEqual(
      toJson(
        DirectoriesResponseSchema,
        await h.files({ projectId: 'p-1' }).directories({
          paths: ['', 'src', 'src/deep', 'nope', 'README.md', '../outside'],
        }),
      ),
      {
        status: 'ready',
        value: {
          status: 'listed',
          directories: [
            {
              status: 'listed',
              entries: [
                { name: 'src', path: 'src', type: 'directory' },
                { name: 'big.txt', path: 'big.txt', type: 'file' },
                { name: 'image.bin', path: 'image.bin', type: 'file' },
                { name: 'README.md', path: 'README.md', type: 'file' },
              ],
            },
            {
              path: 'src',
              status: 'listed',
              entries: [
                { name: 'deep', path: 'src/deep', type: 'directory' },
                { name: 'a.ts', path: 'src/a.ts', type: 'file' },
              ],
            },
            {
              path: 'src/deep',
              status: 'listed',
              entries: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
            },
            { path: 'nope', status: 'not_found' },
            { path: 'README.md', status: 'not_directory' },
            { path: '../outside', status: 'invalid_path' },
          ],
        },
      },
    );
  });

  test('reads a file as text, cut at the bound, and never shows a binary', async (t) => {
    const root = await workspace(t, FILES);
    const h = await filesPart(t, root);
    const files = h.files({ projectId: 'p-1' });

    assert.deepEqual(
      toJson(ContentResponseSchema, await files.content({ path: 'src/a.ts' })),
      {
        status: 'ready',
        value: {
          status: 'read',
          path: 'src/a.ts',
          content: 'export const a = 1;\n',
          truncated: false,
          binary: false,
        },
      },
    );
    assert.deepEqual(
      toJson(ContentResponseSchema, await files.content({ path: 'big.txt' })),
      {
        status: 'ready',
        value: {
          status: 'read',
          path: 'big.txt',
          content: 'x'.repeat(CONTENT_LIMIT_BYTES),
          truncated: true,
          binary: false,
        },
      },
    );
    assert.deepEqual(
      toJson(ContentResponseSchema, await files.content({ path: 'image.bin' })),
      {
        status: 'ready',
        value: {
          status: 'read',
          path: 'image.bin',
          content: '',
          truncated: false,
          binary: true,
        },
      },
    );
  });

  test('refuses a path that is missing, not a directory or outside the workspace', async (t) => {
    const root = await workspace(t, FILES);
    const h = await filesPart(t, root);
    const files = h.files({ projectId: 'p-1' });

    assert.deepEqual(
      toJson(TreeResponseSchema, await files.tree({ path: 'nope' })),
      { status: 'ready', value: { status: 'not_found' } },
    );
    assert.deepEqual(
      toJson(
        DirectoryResponseSchema,
        await files.directory({ path: 'README.md' }),
      ),
      { status: 'ready', value: { status: 'not_directory' } },
    );
    assert.deepEqual(
      toJson(TreeResponseSchema, await files.tree({ path: '../outside' })),
      { status: 'ready', value: { status: 'invalid_path' } },
    );
    assert.deepEqual(
      toJson(ContentResponseSchema, await files.content({ path: 'src' })),
      { status: 'ready', value: { status: 'not_file' } },
    );
    assert.deepEqual(
      toJson(ContentResponseSchema, await files.content({ path: 'gone.txt' })),
      { status: 'ready', value: { status: 'not_found' } },
    );
  });

  for (const state of NOT_READY) {
    test(`answers a ${state} lease as data for every read`, async (t) => {
      const root = await workspace(t, FILES);
      const h = await filesPart(t, root);
      h.lease.status = state;
      const files = h.files({ projectId: 'p-1' });

      assert.deepEqual(toJson(TreeResponseSchema, await files.tree({})), {
        status: state,
      });
      assert.deepEqual(
        toJson(DirectoryResponseSchema, await files.directory({})),
        { status: state },
      );
      assert.deepEqual(
        toJson(
          ContentResponseSchema,
          await files.content({ path: 'README.md' }),
        ),
        { status: state },
      );
    });
  }
});

/** A `FilesService` implementation that records nothing and answers the tests. */
const answering = (
  overrides: Partial<ServiceImpl<typeof FilesService>> = {},
): Partial<ServiceImpl<typeof FilesService>> => ({
  tree: async () => ({
    status: 'ready',
    value: { status: 'listed', path: 'src', entries: [] },
  }),
  directories: async () => ({
    status: 'ready',
    value: { status: 'listed', directories: [] },
  }),
  content: async () => ({
    status: 'ready',
    value: {
      status: 'read',
      path: 'README.md',
      content: 'hello',
      truncated: false,
      binary: false,
    },
  }),
  createFile: async () => ({
    status: 'ready',
    value: { status: 'created', path: 'src/new.ts' },
  }),
  createDirectory: async () => ({
    status: 'ready',
    value: { status: 'created', path: 'src/new-dir' },
  }),
  ...overrides,
});

/** The window whose host answers `impl`, and the reads over it. */
const windowOver = (impl: Partial<ServiceImpl<typeof FilesService>>) => {
  const window = filesWindow(answering(impl));

  return { window, reads: filesReadsOf(window.services) };
};

/** The window's writes over a host that answers `impl`. */
const writesOver = (impl: Partial<ServiceImpl<typeof FilesService>>) =>
  filesWritesOf(filesWindow(answering(impl)).services);

describe('the window reads over files/v1', () => {
  test('every read reaches FilesService with the Project scope', async () => {
    const window = filesWindow(answering());
    const reads = filesReadsOf(window.services);

    await reads.tree('p-1', 'src');
    await reads.directories('p-1', ['src']);
    await reads.file('p-1', 'README.md');

    assert.deepEqual(window.calls, [
      {
        method: `${FilesService.typeName}/Tree`,
        part: 'files',
        scope: { projectId: 'p-1' },
      },
      {
        method: `${FilesService.typeName}/Directories`,
        part: 'files',
        scope: { projectId: 'p-1' },
      },
      {
        method: `${FilesService.typeName}/Content`,
        part: 'files',
        scope: { projectId: 'p-1' },
      },
    ]);
  });

  test('a ready tree and file arrive as the REST client read them', async () => {
    const { reads } = windowOver({
      tree: async () => ({
        status: 'ready',
        value: {
          status: 'listed',
          path: 'src/deep',
          entries: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
        },
      }),
    });

    assert.deepEqual(await reads.tree('p-1', 'src/deep'), {
      status: 'ready',
      path: 'src/deep',
      entries: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
    });
    assert.deepEqual(await reads.file('p-1', 'README.md'), {
      status: 'ready',
      file: {
        path: 'README.md',
        content: 'hello',
        truncated: false,
        binary: false,
      },
    });
  });

  test('a tree keeps the entries the tree nests, and a binary file its flag', async () => {
    const { reads } = windowOver({
      tree: async () => ({
        status: 'ready',
        value: {
          status: 'listed',
          path: '',
          entries: [
            {
              name: 'deep',
              path: 'src/deep',
              type: 'directory',
              children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
            },
          ],
        },
      }),
      content: async () => ({
        status: 'ready',
        value: {
          status: 'read',
          path: 'image.bin',
          content: '',
          truncated: false,
          binary: true,
        },
      }),
    });

    assert.deepEqual(await reads.tree('p-1'), {
      status: 'ready',
      path: '',
      entries: [
        {
          name: 'deep',
          path: 'src/deep',
          type: 'directory',
          children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
        },
      ],
    });
    assert.deepEqual(await reads.file('p-1', 'image.bin'), {
      status: 'ready',
      file: {
        path: 'image.bin',
        content: '',
        truncated: false,
        binary: true,
      },
    });
  });

  test('several directories arrive keyed by the path each was asked as', async () => {
    const { reads } = windowOver({
      directories: async () => ({
        status: 'ready',
        value: {
          status: 'listed',
          directories: [
            {
              path: 'src/deep',
              status: 'listed',
              entries: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
            },
            { path: 'nope', status: 'not_found' },
          ],
        },
      }),
    });

    assert.deepEqual(await reads.directories('p-1', ['src/deep', 'nope']), {
      status: 'ready',
      directories: {
        'src/deep': {
          status: 'listed',
          entries: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
        },
        nope: { status: 'not_found' },
      },
    });
  });

  test('a pending lease carries the one-second retry hint; other states pass through', async () => {
    for (const state of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const) {
      const { reads } = windowOver({
        tree: async () => ({ status: state }),
        content: async () => ({ status: state }),
      });

      assert.deepEqual(
        await reads.tree('p-1'),
        state === 'pending'
          ? { status: 'pending', retryAfterSeconds: 1 }
          : { status: state },
      );
      assert.deepEqual(
        await reads.file('p-1', 'README.md'),
        state === 'pending'
          ? { status: 'pending', retryAfterSeconds: 1 }
          : { status: state },
      );
    }
  });

  test('a missing path is not_found and every other refusal is invalid_path', async () => {
    const { reads } = windowOver({
      tree: async () => ({
        status: 'ready',
        value: { status: 'not_found' },
      }),
      directories: async () => ({
        status: 'ready',
        value: {
          status: 'listed',
          directories: [{ path: 'up', status: 'invalid_path' }],
        },
      }),
      content: async () => ({
        status: 'ready',
        value: { status: 'not_file' },
      }),
    });

    assert.deepEqual(await reads.tree('p-1', 'nope'), { status: 'not_found' });
    assert.deepEqual(await reads.directories('p-1', ['up']), {
      status: 'ready',
      directories: { up: { status: 'invalid_path' } },
    });
    assert.deepEqual(await reads.file('p-1', 'src'), {
      status: 'invalid_path',
    });
    // The content route required a path; the workspace root sent none.
    assert.deepEqual(await reads.file('p-1', ''), { status: 'invalid_path' });
  });

  test('the payload guards refuse before calling the host', async () => {
    const window = filesWindow(answering());
    const reads = filesReadsOf(window.services);

    await assert.rejects(reads.tree('', 'src'), {
      message: 'The item identifier is invalid.',
    });
    await assert.rejects(reads.tree('p-1', '../up'), {
      message: 'The workspace path is invalid.',
    });
    await assert.rejects(reads.file('p-1', '/etc/passwd'), {
      message: 'The workspace path is invalid.',
    });
    await assert.rejects(reads.directories('p-1', []), {
      message: 'The workspace path is invalid.',
    });
    assert.deepEqual(window.calls, []);
  });

  test('a lost backend reads as unavailable, an invalid answer and any other failure as their sentences', async () => {
    for (const code of [
      'unavailable',
      'disconnected',
      'generation_lost',
    ] as const) {
      const { reads } = windowOver({
        tree: async () => {
          throw new ContractError(code, 'gone');
        },
      });

      await assert.rejects(reads.tree('p-1'), {
        message: 'Doric backend is unavailable.',
      });
    }
    const invalid = windowOver({
      content: async () => {
        throw new ContractError('invalid_output', 'bad answer');
      },
    });
    await assert.rejects(invalid.reads.file('p-1', 'README.md'), {
      message: 'Doric returned an invalid response.',
    });
    const other = windowOver({
      tree: async () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(other.reads.tree('p-1'), {
      message: 'The request could not be completed.',
    });
  });

  test('an answer the client cannot read is the invalid-response sentence', async () => {
    const { reads } = windowOver({
      content: async () =>
        ({
          status: 'ready',
          value: { status: 'read', path: 'README.md', content: 5 as never },
        }) as never,
    });

    await assert.rejects(reads.file('p-1', 'README.md'), {
      message: 'Doric returned an invalid response.',
    });
  });
});

describe('the window writes over files/v1', () => {
  test('every write reaches FilesService with the Project scope, and answers what it wrote', async () => {
    const window = filesWindow(answering());
    const writes = filesWritesOf(window.services);

    assert.deepEqual(await writes.createFile('p-1', 'src', 'new.ts'), {
      status: 'ready',
      value: { status: 'created', path: 'src/new.ts' },
    });
    assert.deepEqual(await writes.createDirectory('p-1', 'src', 'new-dir'), {
      status: 'ready',
      value: { status: 'created', path: 'src/new-dir' },
    });
    assert.deepEqual(window.calls, [
      {
        method: `${FilesService.typeName}/CreateFile`,
        part: 'files',
        scope: { projectId: 'p-1' },
      },
      {
        method: `${FilesService.typeName}/CreateDirectory`,
        part: 'files',
        scope: { projectId: 'p-1' },
      },
    ]);
  });

  test('a refused write keeps its reason, and a pending lease its retry hint', async () => {
    const refused = {
      createFile: async () => ({
        status: 'ready',
        value: { status: 'refused', reason: 'exists' },
      }),
    };
    assert.deepEqual(
      await writesOver(refused).createFile('p-1', 'src', 'a.ts'),
      {
        status: 'ready',
        value: { status: 'refused', reason: 'exists' },
      },
    );

    const pending = {
      createDirectory: async () => ({ status: 'pending' }),
    };
    assert.deepEqual(
      await writesOver(pending).createDirectory('p-1', 'src', 'new-dir'),
      { status: 'pending', retryAfterSeconds: 1 },
    );

    const failed = {
      createFile: async () => ({
        status: 'ready',
        value: { status: 'failed', message: 'cannot create src/new.ts' },
      }),
    };
    assert.deepEqual(
      await writesOver(failed).createFile('p-1', 'src', 'new.ts'),
      {
        status: 'ready',
        value: { status: 'failed', message: 'cannot create src/new.ts' },
      },
    );
  });
});
