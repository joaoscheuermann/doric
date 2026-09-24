import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { registerHttpRoutes } from '../src/lib/http/app.js';
import { CONTENT_LIMIT_BYTES } from '../src/lib/workspace/files.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { WorkspaceService } from '../src/lib/workspace/types.js';
import {
  fakeSandbox,
  type FakeSandboxOptions,
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

test('lists a workspace directory with names, relative paths, types and sizes', async (t) => {
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

test('rejects a path that escapes the workspace before touching the sandbox', async (t) => {
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

test('caps file content, flagging truncation and binary payloads', async (t) => {
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

test('reports a missing file and a directory read as content', async (t) => {
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

test('parses the changes list from git status and passes the diff through', async (t) => {
  const harness = await withService({
    entries: [{ path: 'src/a.ts', content: 'x' }],
    status:
      '?? src/new.ts\n M src/a.ts\nA  src/b.ts\nD  src/gone.ts\nR  old.ts -> new.ts\n',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n',
  });
  t.after(harness.dispose);

  assert.deepEqual(await harness.service.projects.diff(harness.projectId), {
    status: 'ready',
    repository: true,
    diff: 'diff --git a/src/a.ts b/src/a.ts\n',
    changes: [
      { path: 'src/new.ts', status: 'untracked' },
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/b.ts', status: 'added' },
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'new.ts', status: 'renamed' },
    ],
  });
});

test('reports no repository when git status fails', async (t) => {
  const harness = await withService({
    entries: [{ path: 'a.ts', content: 'x' }],
  });
  t.after(harness.dispose);

  assert.deepEqual(await harness.service.projects.diff(harness.projectId), {
    status: 'ready',
    repository: false,
    diff: '',
    changes: [],
  });
});

test('scopes the diff to the requested path', async (t) => {
  const harness = await withService({
    entries: [{ path: 'src/a.ts', content: 'x' }],
    status: ' M src/a.ts\n',
  });
  t.after(harness.dispose);

  const result = await harness.service.projects.diff(
    harness.projectId,
    'src/a.ts',
  );
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('expected a ready diff');
  assert.equal(result.path, 'src/a.ts');
  assert.deepEqual(harness.environment.diffs, [{ paths: ['src/a.ts'] }]);
});

type ErrorBody = { error: { code: string } };

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
      diff: async () => ({
        status: 'ready',
        repository: true,
        diff: '',
        changes: [],
      }),
      ...overrides,
    },
  } as unknown as WorkspaceService;
  const app = express();
  const unsupported = (): never => {
    throw new Error('Unexpected core service access');
  };
  registerHttpRoutes(app, {
    config: { current: unsupported, replace: unsupported },
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

test('serves a scoped directory listing from the files route', async (t) => {
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

test('rejects an escaping path with 422 and a missing path with 404', async (t) => {
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
  test(`reports ${status} for the files route without caching`, async (t) => {
    const host = await serve({ files: async () => ({ status }) });
    t.after(host.close);
    const response = await host.request(`/projects/${projectId}/files`);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 'pending')
      assert.equal(response.headers.get('retry-after'), '1');
  });
}

test('serves file content and maps its path failures', async (t) => {
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

test('rejects a file content request without a path or with a NUL byte', async (t) => {
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

test('serves the diff and echoes a scoped path', async (t) => {
  const host = await serve({
    diff: async (_id, path) => ({
      status: 'ready',
      ...(path === undefined ? {} : { path }),
      repository: true,
      diff: 'diff --git a/a.ts b/a.ts\n',
      changes: [{ path: 'a.ts', status: 'modified' }],
    }),
  });
  t.after(host.close);

  const whole = await host.request(`/projects/${projectId}/diff`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await whole.json(), {
    repository: true,
    diff: 'diff --git a/a.ts b/a.ts\n',
    changes: [{ path: 'a.ts', status: 'modified' }],
  });

  const scoped = await host.request(`/projects/${projectId}/diff?path=a.ts`);
  assert.equal(scoped.status, 200);
  assert.equal(((await scoped.json()) as { path: string }).path, 'a.ts');
});

test('maps diff path failures to 404 and 422', async (t) => {
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
