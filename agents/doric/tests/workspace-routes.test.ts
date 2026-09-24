import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { registerHttpRoutes } from '../src/lib/http/app.js';
import type {
  Page,
  Project,
  Thread,
  WorkspaceService,
} from '../src/lib/workspace/types.js';

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';
const project: Project = {
  id: projectId,
  name: 'Project',
  state: 'ready',
  configRevision: 1,
  createdAt: '',
  updatedAt: '',
};
const thread: Thread = {
  id: threadId,
  projectId,
  name: 'Thread',
  state: 'ready',
  lastSequence: 0,
  createdAt: '',
  updatedAt: '',
};

// These are HTTP adapter tests: service outcomes are controlled below.
// Workspace lifecycle and persistence are exercised in their own suites.
test('maps separate Project and Thread creation and list results', async (t) => {
  const host = await serve({
    threads: { list: async () => ({ items: [thread] }) },
  });
  t.after(host.close);
  const created = await host.request('/projects', 'POST', {
    name: '  Project  ',
  });
  assert.equal(created.status, 202);
  const createdBody = (await created.json()) as Project & {
    ssh: { href: string };
  };
  assert.equal(createdBody.name, 'Project');
  assert.equal(createdBody.ssh.href, `/projects/${projectId}/ssh`);
  const conversation = await host.request(
    `/projects/${projectId}/threads`,
    'POST',
    { name: '  Thread  ' },
  );
  assert.equal(conversation.status, 201);
  assert.equal(((await conversation.json()) as Thread).name, 'Thread');
  const after = await host.request(`/projects/${projectId}/threads`);
  const page = (await after.json()) as Page<Thread>;
  assert.equal(page.items[0]?.id, threadId);
  assert.equal(page.items[0]?.name, 'Thread');
  const projects = (await (
    await host.request('/projects')
  ).json()) as Page<Project>;
  assert.equal(projects.items[0]?.name, 'Project');
});

test('production HTTP registration exposes no legacy Session aliases', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [method, path] of [
    ['POST', '/sessions'],
    ['GET', '/sessions'],
    ['GET', `/sessions/${projectId}`],
  ] as const) {
    assert.equal((await host.request(path, method)).status, 404);
  }
});

test('creates child threads and rejects privileged creation input', async (t) => {
  const host = await serve();
  t.after(host.close);
  const child = await host.request(`/projects/${projectId}/threads`, 'POST', {
    name: 'Child',
    parentThreadId: threadId,
  });
  assert.equal(((await child.json()) as Thread).parentThreadId, threadId);
  for (const body of [
    { prompt: 'task' },
    { source: { kind: 'parent' } },
    { name: 'Child', parentThreadId: 'bad' },
  ]) {
    assert.equal(
      (await host.request(`/projects/${projectId}/threads`, 'POST', body))
        .status,
      422,
    );
  }
});

test('rejects invalid names for Project and Thread creation', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const body of [
    {},
    { name: '   ' },
    { name: 'x'.repeat(81) },
    { name: '😀'.repeat(81) },
    { name: 'before\0after' },
    { name: 'Valid', unexpected: true },
    { name: 42 },
  ]) {
    assert.equal((await host.request('/projects', 'POST', body)).status, 422);
    assert.equal(
      (await host.request(`/projects/${projectId}/threads`, 'POST', body))
        .status,
      422,
    );
  }
});

test('accepts names containing up to 80 Unicode code points', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const name of ['x'.repeat(80), '😀'.repeat(80)]) {
    const createdProject = await host.request('/projects', 'POST', { name });
    assert.equal(createdProject.status, 202);
    assert.equal(((await createdProject.json()) as Project).name, name);
    const createdThread = await host.request(
      `/projects/${projectId}/threads`,
      'POST',
      { name },
    );
    assert.equal(createdThread.status, 201);
    assert.equal(((await createdThread.json()) as Thread).name, name);
  }
});

test('assigns and clears a Project color from the fixed palette', async (t) => {
  const host = await serve({
    projects: {
      setColor: async (id, color) =>
        id === projectId
          ? { ...project, ...(color === undefined ? {} : { color }) }
          : undefined,
    },
  });
  t.after(host.close);
  const assigned = await host.request(`/projects/${projectId}/color`, 'PATCH', {
    color: 'teal',
  });
  assert.equal(assigned.status, 200);
  assert.equal(((await assigned.json()) as Project).color, 'teal');
  const cleared = await host.request(`/projects/${projectId}/color`, 'PATCH', {
    color: null,
  });
  assert.equal(cleared.status, 200);
  assert.equal('color' in ((await cleared.json()) as Project), false);
});

test('rejects colors outside the palette and missing Projects', async (t) => {
  const host = await serve({
    projects: {
      setColor: async (id) => (id === projectId ? project : undefined),
    },
  });
  t.after(host.close);
  for (const body of [
    {},
    { color: 'chartreuse' },
    { color: 7 },
    { color: 'red', extra: 1 },
  ]) {
    assert.equal(
      (await host.request(`/projects/${projectId}/color`, 'PATCH', body))
        .status,
      422,
    );
  }
  assert.equal(
    (
      await host.request(`/projects/${promptId}/color`, 'PATCH', {
        color: 'red',
      })
    ).status,
    404,
  );
});

test('renames Projects and Threads with normalized names', async (t) => {
  const host = await serve({
    projects: {
      rename: async (id, name) =>
        id === projectId ? { ...project, name } : undefined,
    },
    threads: {
      rename: async (id, name) =>
        id === threadId ? { ...thread, name } : undefined,
    },
  });
  t.after(host.close);
  const renamedProject = await host.request(`/projects/${projectId}`, 'PATCH', {
    name: '  Renamed project  ',
  });
  assert.equal(renamedProject.status, 200);
  assert.equal(
    ((await renamedProject.json()) as Project).name,
    'Renamed project',
  );
  const renamedThread = await host.request(`/threads/${threadId}`, 'PATCH', {
    name: '  Renamed thread  ',
  });
  assert.equal(renamedThread.status, 200);
  assert.equal(((await renamedThread.json()) as Thread).name, 'Renamed thread');
});

test('returns 404 for missing rename targets and rejects invalid rename input', async (t) => {
  const host = await serve();
  t.after(host.close);
  assert.equal(
    (
      await host.request(`/projects/${promptId}`, 'PATCH', {
        name: 'Missing',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await host.request(`/threads/${promptId}`, 'PATCH', {
        name: 'Missing',
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await host.request(`/projects/${projectId}`, 'PATCH', {
        name: ' ',
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await host.request(`/threads/${threadId}`, 'PATCH', {
        name: 'x'.repeat(81),
      })
    ).status,
    422,
  );
});

test('accepts human prompts but rejects blank text and forged origin', async (t) => {
  const host = await serve();
  t.after(host.close);
  const path = `/threads/${threadId}/prompt`;
  const accepted = await host.request(path, 'POST', { prompt: 'Do the work' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { promptId });
  for (const body of [
    { prompt: ' ' },
    {},
    { prompt: 'Do it', source: { kind: 'parent' } },
  ]) {
    assert.equal((await host.request(path, 'POST', body)).status, 422);
  }
});

test('rewinds an earlier prompt and reports its refusal reasons', async (t) => {
  const host = await serve();
  t.after(host.close);
  const path = `/threads/${threadId}/rewind`;
  const accepted = await host.request(path, 'POST', {
    promptId,
    prompt: 'Do the work differently',
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { promptId });
  for (const body of [
    {},
    { promptId, prompt: ' ' },
    { promptId: 'not-an-id', prompt: 'Edited' },
    { promptId, prompt: 'Edited', source: { kind: 'parent' } },
  ]) {
    assert.equal((await host.request(path, 'POST', body)).status, 422);
  }
  assert.equal(
    (
      await host.request(`/threads/${promptId}/rewind`, 'POST', {
        promptId,
        prompt: 'Edited',
      })
    ).status,
    404,
  );
});

test('maps rewind conflicts and unknown prompts to stable error codes', async (t) => {
  const cases = [
    ['busy', 409, 'thread_busy'],
    ['unknown_prompt', 404, 'prompt_not_found'],
    ['inactive', 409, 'thread_inactive'],
  ] as const;
  for (const [status, expected, code] of cases) {
    const host = await serve({ threads: { rewind: async () => ({ status }) } });
    t.after(host.close);
    const response = await host.request(`/threads/${threadId}/rewind`, 'POST', {
      promptId,
      prompt: 'Edited',
    });
    assert.equal(response.status, expected);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, code);
    assert.ok(body.error.message.length > 0);
  }
});

test('requires prompt-scoped interruption and reports stale execution conflicts', async (t) => {
  const host = await serve();
  t.after(host.close);
  const path = `/threads/${threadId}/interrupt`;
  assert.equal((await host.request(path, 'POST')).status, 422);
  assert.equal(
    (await host.request(path, 'POST', { promptId: projectId })).status,
    409,
  );
  const interrupted = await host.request(path, 'POST', { promptId });
  assert.equal(interrupted.status, 200);
  assert.deepEqual(await interrupted.json(), { status: 'interrupted' });
});

test('forwards the replay cursor, prohibits caching and validates identifiers and pages', async (t) => {
  const host = await serve({
    threads: {
      events: async (id, cursor) => {
        assert.equal(id, threadId);
        assert.equal(cursor, 1);
        return {
          events: [
            {
              sequence: 2,
              projectId,
              threadId,
              promptId,
              type: 'text.delta',
              event: {},
              createdAt: '',
            },
          ],
          lastSequence: 2,
        };
      },
    },
  });
  t.after(host.close);
  const response = await host.request(
    `/threads/${threadId}/events?afterSequence=1`,
  );
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as {
    events: { sequence: number }[];
    lastSequence: number;
  };
  assert.deepEqual(
    body.events.map((event: { sequence: number }) => event.sequence),
    [2],
  );
  assert.equal(body.lastSequence, 2);
  assert.equal(
    (await host.request(`/threads/${threadId}/events?afterSequence=-1`)).status,
    400,
  );
  assert.equal((await host.request('/projects?limit=101')).status, 400);
  assert.equal((await host.request('/threads/not-an-id')).status, 400);
});

test('rejects invalid project and thread IDs before handling resource operations', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [kind, operations] of [
    [
      'project',
      [
        ['GET', ''],
        ['PATCH', ''],
        ['PATCH', '/color'],
        ['DELETE', ''],
        ['GET', '/ssh'],
        ['GET', '/threads'],
        ['POST', '/threads'],
        ['POST', '/terminate'],
      ],
    ],
    [
      'thread',
      [
        ['GET', ''],
        ['PATCH', ''],
        ['DELETE', ''],
        ['GET', '/events'],
        ['POST', '/prompt'],
        ['POST', '/rewind'],
        ['POST', '/interrupt'],
        ['POST', '/terminate'],
      ],
    ],
  ] as const) {
    for (const [method, suffix] of operations) {
      const response = await host.request(
        `/${kind}s/not-an-id${suffix}`,
        method,
      );
      assert.equal(response.status, 400);
      const { error } = (await response.json()) as {
        error: { code: string; message: unknown };
      };
      assert.equal(error.code, `invalid_${kind}_id`);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message);
    }
  }
});

test('reports missing resources and refuses active deletion', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [kind, id] of [
    ['projects', projectId],
    ['threads', threadId],
  ]) {
    assert.equal((await host.request(`/${kind}/${promptId}`)).status, 404);
    assert.equal((await host.request(`/${kind}/${id}`, 'DELETE')).status, 409);
  }
});

test('maps termination and successful deletion outcomes for Projects and Threads', async (t) => {
  const host = await serve({
    projects: { delete: async () => 'deleted' },
    threads: { delete: async () => 'deleted' },
  });
  t.after(host.close);
  for (const [kind, id] of [
    ['threads', threadId],
    ['projects', projectId],
  ]) {
    const path = `/${kind}/${id}`;
    const stopped = await host.request(`${path}/terminate`, 'POST');
    assert.equal(
      ((await stopped.json()) as Project | Thread).state,
      'cancelled',
    );
    assert.equal((await host.request(path, 'DELETE')).status, 204);
  }
});

test('returns private project SSH access and sanitizes unexpected failures', async (t) => {
  const host = await serve();
  t.after(host.close);
  const response = await host.request(`/projects/${projectId}/ssh`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    ((await response.json()) as { href: string }).href,
    '/vms/vm-1/ssh',
  );
  const failed = await host.request(`/projects/${promptId}/ssh`);
  assert.equal(failed.status, 500);
  const failure = (await failed.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(failure.error.code, 'internal_error');
  assert.equal(typeof failure.error.message, 'string');
  assert.ok(failure.error.message.length > 0);
  assert.doesNotMatch(JSON.stringify(failure), /secret provider credentials/);
});

for (const [status, expected] of [
  ['pending', 202],
  ['expired', 410],
  ['unavailable', 409],
  ['missing', 404],
] as const) {
  test(`reports ${status} project SSH access without exposing or caching credentials`, async (t) => {
    const host = await serve({ projects: { ssh: async () => ({ status }) } });
    t.after(host.close);
    const response = await host.request(`/projects/${projectId}/ssh`);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 'pending')
      assert.equal(response.headers.get('retry-after'), '1');
    assert.equal('ssh' in ((await response.json()) as object), false);
  });
}

test('rejects cross-project parenting and inputs into inactive threads', async (t) => {
  const host = await serve({
    threads: {
      create: async () => ({ status: 'invalid_parent' }),
      prompt: async () => ({ status: 'inactive' }),
    },
  });
  t.after(host.close);
  const child = await host.request(`/projects/${projectId}/threads`, 'POST', {
    name: 'Child',
    parentThreadId: promptId,
  });
  assert.equal(child.status, 409);
  assert.equal(
    ((await child.json()) as ErrorBody).error.code,
    'thread_invalid_parent',
  );
  const prompt = await host.request(`/threads/${threadId}/prompt`, 'POST', {
    prompt: 'Try again',
  });
  assert.equal(prompt.status, 409);
  assert.equal(
    ((await prompt.json()) as ErrorBody).error.code,
    'thread_inactive',
  );
});

test('forwards pagination cursors and parent filters and preserves the next cursor', async (t) => {
  const host = await serve({
    threads: {
      list: async (_id, limit, cursor, parentThreadId) => ({
        items: [{ ...thread, parentThreadId }],
        ...(limit === 100 && cursor === promptId
          ? { nextCursor: threadId }
          : {}),
      }),
    },
  });
  t.after(host.close);
  const response = await host.request(
    `/projects/${projectId}/threads?limit=100&cursor=${promptId}&parentThreadId=${projectId}`,
  );
  const page = (await response.json()) as Page<Thread>;
  assert.equal(page.items[0]?.parentThreadId, projectId);
  assert.equal(page.nextCursor, threadId);
});

type ErrorBody = { error: { code: string } };

const serve = async (
  overrides: {
    projects?: Partial<WorkspaceService['projects']>;
    threads?: Partial<WorkspaceService['threads']>;
  } = {},
) => {
  const service: WorkspaceService = {
    projects: {
      create: async (name) => ({ ...project, name }),
      find: async (id) => (id === projectId ? project : undefined),
      list: async () => ({ items: [project] }),
      rename: async (id, name) =>
        id === projectId ? { ...project, name } : undefined,
      setColor: async (id, color) =>
        id === projectId
          ? { ...project, ...(color === undefined ? {} : { color }) }
          : undefined,
      terminate: async () => ({ ...project, state: 'cancelled' }),
      delete: async () => 'active',
      ssh: async (id) => {
        if (id !== projectId) throw new Error('secret provider credentials');
        return {
          status: 'ready',
          vmId: 'vm-1',
          ssh: {
            host: '127.0.0.1',
            port: 22,
            username: 'root',
            privateKey: 'private',
            knownHosts: '',
            hostKeyFingerprint: '',
          },
        };
      },
      files: async () => ({ status: 'ready', path: '', entries: [] }),
      file: async (_id, path) => ({
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
      ...overrides.projects,
    },
    threads: {
      create: async (_id, name, parentThreadId) => ({
        status: 'created',
        thread: {
          ...thread,
          name,
          ...(parentThreadId ? { parentThreadId } : {}),
        },
      }),
      find: async (id) => (id === threadId ? thread : undefined),
      list: async () => ({ items: [] }),
      rename: async (id, name) =>
        id === threadId ? { ...thread, name } : undefined,
      prompt: async () => ({ status: 'accepted', promptId }),
      rewind: async (id) =>
        id === threadId
          ? { status: 'accepted', promptId }
          : { status: 'missing' },
      events: async () => ({ events: [], lastSequence: 0 }),
      interrupt: async (_id, target) =>
        target === promptId ? 'interrupted' : 'not_running',
      terminate: async () => ({ ...thread, state: 'cancelled' }),
      delete: async () => 'active',
      ...overrides.threads,
    },
    sshForVm: async () => undefined,
    dispose: async () => undefined,
  };
  const app = express();
  const unsupported = (): never => {
    throw new Error('Unexpected config access');
  };
  registerHttpRoutes(app, {
    config: { current: unsupported, replace: unsupported },
    service,
    vms: { list: () => [], find: () => undefined, ssh: service.sshForVm },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    request: (path: string, method = 'GET', body?: unknown) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
