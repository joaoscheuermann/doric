import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTENT_LIMIT_BYTES } from '../../src/host/provisional/files.js';
import { createHarness } from '../domain/support/harness.js';
import { type FakeSandboxOptions, fakeSandbox } from '../support/sandbox.js';

/*
 * The service half of agents/doric tests/workspace-files.test.ts (design 57
 * §13.1, stage 5 "Lease and lease reads"): the Project file reads through
 * runtime.lease/v1 with a Project scope. The route half is the transport's.
 */

/** A ready Project backed by the real runtime and a scripted sandbox. */
const withService = async (options: FakeSandboxOptions = {}) => {
  const environment = fakeSandbox(options);
  const harness = createHarness({ sandbox: { sandbox: environment as never } });
  const project = await harness.readyProject();
  return {
    service: harness.service,
    environment,
    projectId: project.id,
    dispose: () => harness.dispose(),
  };
};

void test('lists the whole workspace as one nested tree', async (t) => {
  const harness = await withService({
    entries: [
      { path: 'README.md', content: 'hello' },
      { path: 'src/a.ts', content: 'abc' },
      { path: 'src/deep/b.ts', content: 'abcd' },
    ],
  });
  t.after(harness.dispose);

  // A tree node carries no size: one recursive walk measures nothing, which is
  // part of why the whole tree is one cheap read.
  assert.deepEqual(await harness.service.projects.tree(harness.projectId), {
    status: 'ready',
    path: '',
    entries: [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [
          {
            name: 'deep',
            path: 'src/deep',
            type: 'directory',
            children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
          },
          { name: 'a.ts', path: 'src/a.ts', type: 'file' },
        ],
      },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ],
  });
});

void test('reads the tree from a subdirectory and refuses a path outside it', async (t) => {
  const harness = await withService({
    entries: [{ path: 'src/deep/b.ts', content: 'abcd' }],
  });
  t.after(harness.dispose);

  assert.deepEqual(
    await harness.service.projects.tree(harness.projectId, 'src'),
    {
      status: 'ready',
      path: 'src',
      entries: [
        {
          name: 'deep',
          path: 'src/deep',
          type: 'directory',
          children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
        },
      ],
    },
  );
  assert.deepEqual(
    await harness.service.projects.tree(harness.projectId, '../outside'),
    { status: 'invalid_path' },
  );
  assert.deepEqual(
    await harness.service.projects.tree(harness.projectId, 'nope'),
    { status: 'not_found' },
  );
});

void test('keeps the files route listing one level while the tree nests', async (t) => {
  const harness = await withService({
    entries: [{ path: 'src/deep/b.ts', content: 'abcd' }],
  });
  t.after(harness.dispose);

  const listing = await harness.service.projects.files(
    harness.projectId,
    'src',
  );
  assert.equal(listing.status, 'ready');
  if (listing.status !== 'ready') throw new Error('expected a listing');
  assert.deepEqual(listing.entries, [
    { name: 'deep', path: 'src/deep', type: 'directory' },
  ]);

  const tree = await harness.service.projects.tree(harness.projectId, 'src');
  assert.equal(tree.status, 'ready');
  if (tree.status !== 'ready') throw new Error('expected a tree');
  assert.deepEqual(tree.entries, [
    {
      name: 'deep',
      path: 'src/deep',
      type: 'directory',
      children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
    },
  ]);
});

void test('lists a workspace directory with names, relative paths, types and sizes', async (t) => {
  const harness = await withService({
    entries: [
      { path: 'README.md', content: 'hello' },
      { path: 'src/a.ts', content: 'abc' },
    ],
  });
  t.after(harness.dispose);

  assert.deepEqual(await harness.service.projects.files(harness.projectId), {
    status: 'ready',
    path: '',
    entries: [
      { name: 'src', path: 'src', type: 'directory' },
      { name: 'README.md', path: 'README.md', type: 'file', size: 5 },
    ],
  });
  assert.deepEqual(
    await harness.service.projects.files(harness.projectId, 'src'),
    {
      status: 'ready',
      path: 'src',
      entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 }],
    },
  );
});

void test('rejects a path that escapes the workspace before touching the sandbox', async (t) => {
  const harness = await withService({
    entries: [{ path: 'a.ts', content: 'x' }],
  });
  t.after(harness.dispose);

  assert.deepEqual(
    await harness.service.projects.files(harness.projectId, '../outside'),
    {
      status: 'invalid_path',
    },
  );
  assert.deepEqual(
    await harness.service.projects.file(harness.projectId, '../../etc/passwd'),
    {
      status: 'invalid_path',
    },
  );
  assert.deepEqual(
    await harness.service.projects.diff(harness.projectId, '../outside'),
    {
      status: 'invalid_path',
    },
  );
  assert.deepEqual(harness.environment.execs, []);
});

void test('caps file content, flagging truncation and binary payloads', async (t) => {
  const harness = await withService({
    entries: [
      { path: 'big.txt', content: 'a'.repeat(CONTENT_LIMIT_BYTES + 10) },
      { path: 'bin.dat', content: 'a\u0000b' },
    ],
  });
  t.after(harness.dispose);

  const capped = await harness.service.projects.file(
    harness.projectId,
    'big.txt',
  );
  assert.equal(capped.status, 'ready');
  if (capped.status !== 'ready') throw new Error('expected a ready read');
  assert.equal(capped.truncated, true);
  assert.equal(capped.binary, false);
  assert.equal(capped.content.length, CONTENT_LIMIT_BYTES);

  const binary = await harness.service.projects.file(
    harness.projectId,
    'bin.dat',
  );
  assert.equal(binary.status, 'ready');
  if (binary.status !== 'ready') throw new Error('expected a ready read');
  assert.equal(binary.binary, true);
  assert.equal(binary.truncated, false);
  assert.equal(binary.content, '');
});

void test('reports a missing file and a directory read as content', async (t) => {
  const harness = await withService({
    entries: [
      { path: 'a.ts', content: 'x' },
      { path: 'src/b.ts', content: 'y' },
    ],
  });
  t.after(harness.dispose);

  assert.deepEqual(
    await harness.service.projects.file(harness.projectId, 'nope.ts'),
    {
      status: 'not_found',
    },
  );
  assert.deepEqual(
    await harness.service.projects.file(harness.projectId, 'src'),
    {
      status: 'not_file',
    },
  );
});

void test('returns one entry per repository, each with its own changes and diff', async (t) => {
  const harness = await withService({
    repositories: [
      {
        path: 'alpha',
        status:
          '?? src/new.ts\n M src/a.ts\nA  src/b.ts\nD  src/gone.ts\nR  old.ts -> new.ts\n',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n',
      },
      {
        path: 'beta',
        status: ' M lib/b.ts\n',
        diff: 'diff --git a/lib/b.ts b/lib/b.ts\n',
      },
    ],
  });
  t.after(harness.dispose);

  assert.deepEqual(await harness.service.projects.diff(harness.projectId), {
    status: 'ready',
    repositories: [
      {
        path: 'alpha',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n',
        changes: [
          { path: 'src/new.ts', status: 'untracked' },
          { path: 'src/a.ts', status: 'modified' },
          { path: 'src/b.ts', status: 'added' },
          { path: 'src/gone.ts', status: 'deleted' },
          { path: 'new.ts', status: 'renamed' },
        ],
      },
      {
        path: 'beta',
        diff: 'diff --git a/lib/b.ts b/lib/b.ts\n',
        changes: [{ path: 'lib/b.ts', status: 'modified' }],
      },
    ],
  });
});

void test('reports no repositories when the workspace holds none', async (t) => {
  const harness = await withService({
    entries: [{ path: 'a.ts', content: 'x' }],
  });
  t.after(harness.dispose);

  assert.deepEqual(await harness.service.projects.diff(harness.projectId), {
    status: 'ready',
    repositories: [],
  });
});

void test('echoes a requested path without scoping the repositories', async (t) => {
  const harness = await withService({
    repositories: [{ path: 'alpha', status: ' M src/a.ts\n' }],
  });
  t.after(harness.dispose);

  const result = await harness.service.projects.diff(
    harness.projectId,
    'alpha',
  );
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected a ready diff');
  assert.equal(result.path, 'alpha');
  assert.deepEqual(harness.environment.diffs, [{ cwd: 'alpha' }]);
});

void test('rejects unsafe individual comparison paths before reading the sandbox', async (t) => {
  const harness = await withService();
  t.after(harness.dispose);
  for (const [repository, path] of [
    ['../outside', 'a.ts'],
    ['', '../outside'],
    ['', 'a\0b'],
  ]) {
    assert.deepEqual(
      await harness.service.projects.fileDiff(
        harness.projectId,
        repository ?? '',
        path ?? '',
      ),
      { status: 'invalid_path' },
    );
  }
  assert.deepEqual(harness.environment.execs, []);
});
