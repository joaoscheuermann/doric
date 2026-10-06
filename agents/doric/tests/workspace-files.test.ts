import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { registerHttpRoutes } from '../src/lib/http/app.js';
import { CONTENT_LIMIT_BYTES } from '../src/lib/workspace/files.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { WorkspaceService } from '../src/lib/workspace/types.js';
import {
  credentialResolver,
  type FakeSandboxOptions,
  fakeSandbox,
  pool,
  workspace,
} from './helpers/workspace.js';

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';

/** A ready Project backed by the real service and a scripted sandbox. */
const withService = async (options: FakeSandboxOptions = {}) => {
  const harness = workspace();
  const environment = fakeSandbox(options);
  const service = createWorkspaceService({
    ...harness.dependencies,
    pool: pool(undefined, environment),
    execute: async () => 'done',
  });
  const project = await service.projects.create('Project');
  await harness.projectState(project.id, 'ready');
  return {
    service,
    environment,
    projectId: project.id,
    dispose: () => service.dispose(),
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

interface ErrorBody {
  error: { code: string };
}

const serve = async (overrides: Partial<WorkspaceService['projects']> = {}) => {
  const service = {
    projects: {
      files: async () => ({ status: 'ready', path: '', entries: [] }),
      file: async (_id: string, path: string) => ({
        status: 'ready',
        path,
        content: '',
        truncated: false,
        binary: false,
      }),
      tree: async () => ({ status: 'ready', path: '', entries: [] }),
      diff: async () => ({ status: 'ready', repositories: [] }),
      ...overrides,
    },
  } as unknown as WorkspaceService;
  const app = express();
  const unsupported = (): never => {
    throw new Error('Unexpected core service access');
  };
  registerHttpRoutes(app, {
    config: { current: unsupported, replace: unsupported },
    credentials: credentialResolver(),
    logger: { warn: () => undefined } as never,
    service,
    vms: { list: () => [], find: () => undefined, ssh: async () => undefined },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    request: (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

void test('serves a scoped directory listing from the files route', async (t) => {
  let received: string | undefined;
  const host = await serve({
    files: async (_id, path) => {
      received = path;
      return {
        status: 'ready',
        path: 'src',
        entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 }],
      };
    },
  });
  t.after(host.close);

  const response = await host.request(`/projects/${projectId}/files?path=src`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(received, 'src');
  assert.deepEqual(await response.json(), {
    path: 'src',
    entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 }],
  });
});

void test('serves the whole tree, nested, from the tree route', async (t) => {
  let received: string | undefined;
  const host = await serve({
    tree: async (_id, path) => {
      received = path;
      return {
        status: 'ready',
        path: '',
        entries: [
          {
            name: 'src',
            path: 'src',
            type: 'directory',
            children: [
              { name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 },
            ],
          },
          { name: 'README.md', path: 'README.md', type: 'file', size: 9 },
        ],
      };
    },
  });
  t.after(host.close);

  const response = await host.request(`/projects/${projectId}/tree`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(received, undefined);
  assert.deepEqual(await response.json(), {
    path: '',
    entries: [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [{ name: 'a.ts', path: 'src/a.ts', type: 'file', size: 3 }],
      },
      { name: 'README.md', path: 'README.md', type: 'file', size: 9 },
    ],
  });
});

void test('rejects an escaping tree path with 422 and a missing one with 404', async (t) => {
  const escaping = await serve({
    tree: async () => ({ status: 'invalid_path' }),
  });
  t.after(escaping.close);
  const rejected = await escaping.request(
    `/projects/${projectId}/tree?path=../x`,
  );
  assert.equal(rejected.status, 422);
  assert.equal(
    ((await rejected.json()) as ErrorBody).error.code,
    'invalid_project_path',
  );

  const absent = await serve({ tree: async () => ({ status: 'not_found' }) });
  t.after(absent.close);
  const missing = await absent.request(`/projects/${projectId}/tree?path=nope`);
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as ErrorBody).error.code,
    'project_path_not_found',
  );
});

void test('rejects an escaping path with 422 and a missing path with 404', async (t) => {
  const escaping = await serve({
    files: async () => ({ status: 'invalid_path' }),
  });
  t.after(escaping.close);
  const rejected = await escaping.request(
    `/projects/${projectId}/files?path=../x`,
  );
  assert.equal(rejected.status, 422);
  assert.equal(
    ((await rejected.json()) as ErrorBody).error.code,
    'invalid_project_path',
  );

  const absent = await serve({ files: async () => ({ status: 'not_found' }) });
  t.after(absent.close);
  const missing = await absent.request(
    `/projects/${projectId}/files?path=nope`,
  );
  assert.equal(missing.status, 404);
  assert.equal(
    ((await missing.json()) as ErrorBody).error.code,
    'project_path_not_found',
  );
});

for (const [status, expected] of [
  ['pending', 202],
  ['expired', 410],
  ['unavailable', 409],
  ['missing', 404],
] as const) {
  void test(`reports ${status} for the files route without caching`, async (t) => {
    const host = await serve({ files: async () => ({ status }) });
    t.after(host.close);
    const response = await host.request(`/projects/${projectId}/files`);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 'pending')
      assert.equal(response.headers.get('retry-after'), '1');
  });

  void test(`reports ${status} for the tree route without caching`, async (t) => {
    const host = await serve({ tree: async () => ({ status }) });
    t.after(host.close);
    const response = await host.request(`/projects/${projectId}/tree`);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 'pending')
      assert.equal(response.headers.get('retry-after'), '1');
  });
}

void test('serves file content and maps its path failures', async (t) => {
  const ready = await serve({
    file: async (_id, path) => ({
      status: 'ready',
      path,
      content: 'hi',
      truncated: true,
      binary: false,
    }),
  });
  t.after(ready.close);
  const response = await ready.request(
    `/projects/${projectId}/files/content?path=src/a.ts`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    path: 'src/a.ts',
    content: 'hi',
    truncated: true,
    binary: false,
  });

  const directory = await serve({ file: async () => ({ status: 'not_file' }) });
  t.after(directory.close);
  assert.equal(
    (await directory.request(`/projects/${projectId}/files/content?path=src`))
      .status,
    422,
  );

  const absent = await serve({ file: async () => ({ status: 'not_found' }) });
  t.after(absent.close);
  assert.equal(
    (await absent.request(`/projects/${projectId}/files/content?path=nope.ts`))
      .status,
    404,
  );
});

void test('rejects a file content request without a path or with a NUL byte', async (t) => {
  const host = await serve();
  t.after(host.close);
  assert.equal(
    (await host.request(`/projects/${projectId}/files/content`)).status,
    422,
  );
  assert.equal(
    (
      await host.request(
        `/projects/${projectId}/files/content?path=${encodeURIComponent('a\u0000b')}`,
      )
    ).status,
    422,
  );
});

void test('serves the diff and echoes a scoped path', async (t) => {
  const host = await serve({
    diff: async (_id, path) => ({
      status: 'ready',
      ...(path === undefined ? {} : { path }),
      repositories: [
        {
          path: 'alpha',
          diff: 'diff --git a/a.ts b/a.ts\n',
          changes: [{ path: 'a.ts', status: 'modified' }],
        },
      ],
    }),
  });
  t.after(host.close);

  const whole = await host.request(`/projects/${projectId}/diff`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await whole.json(), {
    repositories: [
      {
        path: 'alpha',
        diff: 'diff --git a/a.ts b/a.ts\n',
        changes: [{ path: 'a.ts', status: 'modified' }],
      },
    ],
  });

  const scoped = await host.request(`/projects/${projectId}/diff?path=a.ts`);
  assert.equal(scoped.status, 200);
  assert.equal(((await scoped.json()) as { path: string }).path, 'a.ts');
});

void test('maps diff path failures to 404 and 422', async (t) => {
  const absent = await serve({ diff: async () => ({ status: 'not_found' }) });
  t.after(absent.close);
  assert.equal(
    (await absent.request(`/projects/${projectId}/diff?path=nope.ts`)).status,
    404,
  );

  const invalid = await serve({
    diff: async () => ({ status: 'invalid_path' }),
  });
  t.after(invalid.close);
  assert.equal(
    (await invalid.request(`/projects/${projectId}/diff?path=../outside`))
      .status,
    422,
  );
});

void test('serves lightweight changes and an individual diff with exact special paths', async (t) => {
  const change = {
    path: 'new\nfile.ts',
    originalPath: 'old file.ts',
    status: 'renamed' as const,
    staged: true,
    unstaged: false,
    indexStatus: 'R',
    worktreeStatus: ' ',
  };
  const diff = {
    ...change,
    repository: 'repo',
    original: 'old',
    modified: 'new',
    binary: false,
    truncated: false,
  };
  const host = await serve({
    changes: async () => ({
      status: 'ready',
      repositories: [{ path: 'repo', changes: [change], added: 1, removed: 1 }],
    }),
    fileDiff: async (_id, repository, path) => {
      assert.equal(repository, 'repo');
      assert.equal(path, change.path);
      return { status: 'ready', diff };
    },
  });
  t.after(host.close);
  const changes = await host.request(`/projects/${projectId}/changes`);
  assert.equal(changes.status, 200);
  assert.equal(changes.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await changes.json(), {
    repositories: [{ path: 'repo', changes: [change], added: 1, removed: 1 }],
  });
  const comparison = await host.request(
    `/projects/${projectId}/files/diff?repository=repo&path=${encodeURIComponent(change.path)}`,
  );
  assert.equal(comparison.status, 200);
  assert.deepEqual(await comparison.json(), diff);
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
