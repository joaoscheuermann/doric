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
import { credentialResolver } from './helpers/workspace.js';

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
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
};
void test('queue editing returns full input and rejects invalid or stale writes', async (t) => {
  const prompt = { promptId, text: 'Full input', editable: true, revision: 7 };
  const host = await serve({
    threads: {
      queuedPrompt: async () => prompt,
      editQueued: async (_id, _target, text, revision) =>
        revision === 7
          ? { status: 'updated', prompt: { ...prompt, text, revision: 8 } }
          : { status: 'conflict' },
    },
  });
  t.after(host.close);
  const path = `/threads/${threadId}/queue/${promptId}`;
  const read = await host.request(path);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json(), prompt);
  const saved = await host.request(path, 'PATCH', {
    text: 'Edited',
    revision: 7,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    ...prompt,
    text: 'Edited',
    revision: 8,
  });
  assert.equal(
    (await host.request(path, 'PATCH', { text: 'Stale', revision: 6 })).status,
    409,
  );
  for (const body of [
    { text: ' ', revision: 7 },
    { text: 'Missing revision' },
    { text: 'Bad revision', revision: -1 },
  ])
    assert.equal((await host.request(path, 'PATCH', body)).status, 422);
});

void test('reads the queue without caching and maps resume outcomes', async (t) => {
  const queue = { revision: 12, paused: true, stopping: false, items: [] };
  const host = await serve({
    threads: {
      queue: async (id) => (id === threadId ? queue : undefined),
      resumeQueue: async (id) =>
        id === threadId ? { status: 'resumed', thread } : { status: 'missing' },
    },
  });
  t.after(host.close);
  const response = await host.request(`/threads/${threadId}/queue`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), queue);
  assert.equal((await host.request(`/threads/${projectId}/queue`)).status, 404);
  assert.equal((await host.request('/threads/not-a-uuid/queue')).status, 400);
  assert.equal(
    (await host.request(`/threads/${threadId}/queue/resume`, 'POST')).status,
    200,
  );
  assert.equal(
    (await host.request(`/threads/${projectId}/queue/resume`, 'POST')).status,
    404,
  );
  const stopping = await serve({
    threads: { resumeQueue: async () => ({ status: 'busy' }) },
  });
  t.after(stopping.close);
  assert.equal(
    (await stopping.request(`/threads/${threadId}/queue/resume`, 'POST'))
      .status,
    409,
  );
});
void test('queue deletion validates prompt identity and refuses an input already running', async (t) => {
  const host = await serve({
    threads: {
      removeQueued: async (id, target) =>
        id !== threadId ? 'missing' : target === promptId ? 'removed' : 'busy',
    },
  });
  t.after(host.close);
  assert.equal(
    (await host.request(`/threads/${threadId}/queue/${promptId}`, 'DELETE'))
      .status,
    204,
  );
  assert.equal(
    (await host.request(`/threads/${threadId}/queue/${projectId}`, 'DELETE'))
      .status,
    409,
  );
  assert.equal(
    (await host.request(`/threads/${projectId}/queue/${promptId}`, 'DELETE'))
      .status,
    404,
  );
  assert.equal(
    (await host.request(`/threads/${threadId}/queue/not-a-uuid`, 'DELETE'))
      .status,
    422,
  );
});
void test('serves usage without caching and returns missing for an unknown Thread', async (t) => {
  const total = {
    calls: 2,
    unpricedCalls: 0,
    cost: 0.75,
    inputTokens: 48000,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  const host = await serve({
    threads: {
      usage: async (id) =>
        id === threadId ? { total, threads: [] } : undefined,
    },
  });
  t.after(host.close);
  const response = await host.request(`/threads/${threadId}/usage`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(
    ((await response.json()) as { total: { cost: number } }).total.cost,
    0.75,
  );
  assert.equal((await host.request(`/threads/${projectId}/usage`)).status, 404);
});

// These are HTTP adapter tests: service outcomes are controlled below.
// Workspace lifecycle and persistence are exercised in their own suites.
void test('maps separate Project and Thread creation and list results', async (t) => {
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

void test('production HTTP registration exposes no legacy Session aliases', async (t) => {
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

void test('creates child threads and rejects privileged creation input', async (t) => {
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

void test('rejects invalid names for Project and Thread creation', async (t) => {
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

void test('accepts names containing up to 80 Unicode code points', async (t) => {
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

void test('assigns and clears a Project color from the fixed palette', async (t) => {
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

void test('rejects colors outside the palette and missing Projects', async (t) => {
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

void test('renames Projects and Threads with normalized names', async (t) => {
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

void test('returns 404 for missing rename targets and rejects invalid rename input', async (t) => {
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

void test('accepts human prompts but rejects blank text and forged origin', async (t) => {
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

void test('rewinds an earlier prompt and reports its refusal reasons', async (t) => {
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

void test('maps rewind conflicts and unknown prompts to stable error codes', async (t) => {
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

void test('resumes one paused prompt and reports its refusal reasons', async (t) => {
  const host = await serve();
  t.after(host.close);
  const path = `/threads/${threadId}/resume`;
  const accepted = await host.request(path, 'POST', { promptId });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), thread);
  for (const body of [{}, { promptId: 'not-an-id' }, { promptId, extra: 1 }]) {
    assert.equal((await host.request(path, 'POST', body)).status, 422);
  }
  assert.equal(
    (await host.request(`/threads/${promptId}/resume`, 'POST', { promptId }))
      .status,
    404,
  );

  const cases = [
    ['unknown_prompt', 404, 'prompt_not_found'],
    ['busy', 409, 'thread_busy'],
    ['inactive', 409, 'thread_inactive'],
  ] as const;
  for (const [status, expected, code] of cases) {
    const other = await serve({
      threads: { resume: async () => ({ status }) },
    });
    t.after(other.close);
    const response = await other.request(path, 'POST', { promptId });
    assert.equal(response.status, expected);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, code);
    assert.ok(body.error.message.length > 0);
  }
});

void test('requires prompt-scoped interruption and reports stale execution conflicts', async (t) => {
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

void test('forwards the replay cursor, prohibits caching and validates identifiers and pages', async (t) => {
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

void test('moves a Thread working directory, and reports a refusal as an invalid cwd', async (t) => {
  const host = await serve({
    threads: {
      setCwd: async (id, cwd) => {
        if (id !== threadId) return { status: 'missing' };
        if (cwd === 'outside') {
          return { status: 'refused', change: { status: 'outside' } };
        }
        return {
          status: 'updated',
          thread: { ...thread, cwd: `/workspace/${cwd}` },
        };
      },
    },
  });
  t.after(host.close);

  const moved = await host.request(`/threads/${threadId}`, 'PATCH', {
    cwd: 'alpha',
  });
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as Thread).cwd, '/workspace/alpha');

  const refused = await host.request(`/threads/${threadId}`, 'PATCH', {
    cwd: 'outside',
  });
  assert.equal(refused.status, 400);
  const body = (await refused.json()) as ErrorBody & {
    error: { message: string };
  };
  assert.equal(body.error.code, 'invalid_cwd');
  assert.ok(body.error.message.length > 0);

  // A patch that names nothing is not a change, and neither is a blank
  // directory; an unknown Thread is 404.
  assert.equal(
    (await host.request(`/threads/${threadId}`, 'PATCH', {})).status,
    422,
  );
  assert.equal(
    (await host.request(`/threads/${threadId}`, 'PATCH', { cwd: '  ' })).status,
    422,
  );
  assert.equal(
    (await host.request(`/threads/${promptId}`, 'PATCH', { cwd: 'alpha' }))
      .status,
    404,
  );
});

void test('serves a Thread Git summary and reports a missing or inactive Thread', async (t) => {
  const host = await serve({
    threads: {
      git: async (id) =>
        id === threadId
          ? { status: 'ready', git: { repo: false } }
          : { status: 'inactive' },
    },
  });
  t.after(host.close);

  const response = await host.request(`/threads/${threadId}/git`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { repo: false });
  const unavailable = await host.request(`/threads/${promptId}/git`);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), { status: 'unavailable' });
});

void test('serves pending Git and branch reads while refusing mutations without a lease', async (t) => {
  const host = await serve({
    threads: {
      git: async () => ({ status: 'pending' }),
      branches: async () => ({ status: 'pending' }),
    },
  });
  t.after(host.close);
  for (const resource of ['git', 'branches']) {
    const response = await host.request(`/threads/${threadId}/${resource}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'pending' });
  }
  assert.equal(
    (
      await host.request(`/threads/${threadId}/branches`, 'POST', {
        branch: 'main',
        cwd: '/workspace',
      })
    ).status,
    409,
  );
});

void test('lists branches and reports switch refusals without accepting command options', async (t) => {
  const host = await serve({
    threads: {
      branches: async (_id, branch) =>
        branch === undefined
          ? { status: 'ready', value: { branches: [] } }
          : { status: 'refused', message: 'Worktree is busy.' },
    },
  });
  t.after(host.close);
  assert.equal(
    (await host.request(`/threads/${threadId}/branches`)).status,
    200,
  );
  const refused = await host.request(`/threads/${threadId}/branches`, 'POST', {
    branch: 'main',
    cwd: '/workspace',
  });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'branch_refused');
  for (const branch of ['', '--discard-changes', 'bad\0name']) {
    assert.equal(
      (
        await host.request(`/threads/${threadId}/branches`, 'POST', {
          branch,
          cwd: '/workspace',
        })
      ).status,
      422,
    );
  }
});

void test('rejects invalid project and thread IDs before handling resource operations', async (t) => {
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
        ['POST', '/resume'],
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

void test('reports missing resources and refuses active deletion', async (t) => {
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

void test('maps termination and successful deletion outcomes for Projects and Threads', async (t) => {
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

void test('returns private project SSH access and sanitizes unexpected failures', async (t) => {
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
  void test(`reports ${status} project SSH access without exposing or caching credentials`, async (t) => {
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

void test('rejects cross-project parenting and inputs into inactive threads', async (t) => {
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

void test('forwards pagination cursors and parent filters and preserves the next cursor', async (t) => {
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

interface ErrorBody {
  error: { code: string };
}

const serve = async (
  overrides: {
    projects?: Partial<WorkspaceService['projects']>;
    threads?: Partial<WorkspaceService['threads']>;
  } = {},
) => {
  const service: WorkspaceService = {
    terminals: {
      list: () => [],
      create: async () => undefined,
      snapshot: () => undefined,
      input: async () => false,
      resize: async () => false,
      stop: async () => false,
    },
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
      changes: async () => ({ status: 'ready', repositories: [] }),
      fileDiff: async () => ({ status: 'not_found' }),
      file: async (_id, path) => ({
        status: 'ready',
        path,
        content: '',
        truncated: false,
        binary: false,
      }),
      tree: async () => ({ status: 'ready', path: '', entries: [] }),
      diff: async () => ({ status: 'ready', repositories: [] }),
      ...overrides.projects,
    },
    threads: {
      queue: async () => undefined,
      queuedPrompt: async () => undefined,
      editQueued: async () => ({ status: 'unknown_prompt' }),
      removeQueued: async () => 'removed',
      resumeQueue: async () => ({ status: 'missing' }),
      create: async (_id, name, parentThreadId) => ({
        status: 'created',
        thread: {
          ...thread,
          name,
          ...(parentThreadId ? { parentThreadId } : {}),
        },
      }),
      usage: async () => undefined,
      find: async (id) => (id === threadId ? thread : undefined),
      list: async () => ({ items: [] }),
      rename: async (id, name) =>
        id === threadId ? { ...thread, name } : undefined,
      setCwd: async (id, cwd) =>
        id === threadId
          ? { status: 'updated', thread: { ...thread, cwd } }
          : { status: 'missing' },
      git: async (id) =>
        id === threadId
          ? { status: 'ready', git: { repo: false } }
          : { status: 'missing' },
      prompt: async () => ({ status: 'accepted', promptId }),
      branches: async () => ({ status: 'ready', value: { branches: [] } }),
      resume: async (id, target) =>
        id === threadId && target === promptId
          ? { status: 'resumed', thread }
          : { status: 'missing' },
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
    resumeInterrupted: async () => 0,
    recoverProjects: async () => undefined,
    dispose: async () => undefined,
  };
  const app = express();
  const unsupported = (): never => {
    throw new Error('Unexpected config access');
  };
  registerHttpRoutes(app, {
    config: { current: unsupported, replace: unsupported },
    credentials: credentialResolver(),
    logger: { warn: () => undefined } as never,
    service,
    vms: {
      list: () => [],
      find: () => undefined,
      ssh: (id) => service.sshForVm(id),
    },
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
