import assert from 'node:assert/strict';
import test from 'node:test';

import type { Call } from 'bundle/contracts';
import type { Page, Project, Thread } from 'runtime/contracts';

import {
  type ErrorBody,
  type Fakes,
  serve as serveHost,
} from './support/host.js';

/*
 * The Project and Thread routes of agents/doric's workspace-routes suite, run
 * against the transport bundle: each case controls the runtime contracts'
 * answers and checks what an HTTP client receives.
 */

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
const access = {
  host: '127.0.0.1',
  port: 22,
  username: 'root' as const,
  privateKey: 'private',
  knownHosts: '',
  hostKeyFingerprint: '',
};

type ById = { readonly id: string };

/** The scope a lease read was bound to. */
const scopeOf = (call: Call) => call.scope ?? {};

/** The default runtime answers; a case overrides only what it observes. */
const serve = (overrides: Fakes = {}) =>
  serveHost({
    runtime: {
      createProject: ({ name }: { name: string }) => ({ ...project, name }),
      project: (id: string) => (id === projectId ? project : undefined),
      projects: () => ({ items: [project] }),
      renameProject: ({ id, name }: ById & { name: string }) =>
        id === projectId ? { ...project, name } : undefined,
      setProjectColor: ({ id, color }: ById & { color: string | null }) =>
        id === projectId
          ? { ...project, ...(color === null ? {} : { color }) }
          : undefined,
      terminateProject: () => ({ ...project, state: 'cancelled' }),
      deleteProject: () => 'active',
      ...overrides.runtime,
    },
    lease: {
      ssh: (call: Call) => {
        if (scopeOf(call).projectId !== projectId)
          throw new Error('secret provider credentials');
        return { status: 'ready', vmId: 'vm-1', ssh: access };
      },
      ...overrides.lease,
    },
    // The stage-10 feature bundles (stage 10 §4): each lease read answers
    // its outcome as `{ status: 'ready', value }` or the lease state.
    files: {
      directory: () => ready({ status: 'listed', path: '', entries: [] }),
      tree: () => ready({ status: 'listed', path: '', entries: [] }),
      content: ({ path }: { path: string }) =>
        ready({
          status: 'read',
          path,
          content: '',
          truncated: false,
          binary: false,
        }),
      ...overrides.files,
    },
    git: {
      changes: () => ready({ status: 'read', repositories: [] }),
      diff: () => ready({ status: 'read', repositories: [] }),
      fileDiff: () => ready({ status: 'not_found' }),
      status: (id: string) =>
        id === threadId ? ready({ repo: false }) : { status: 'missing' },
      branches: () => ready({ branches: [] }),
      ...overrides.git,
    },
    resources: {
      project: () => ({ status: 'pending' }),
      ...overrides.resources,
    },
    usage: { thread: () => undefined, ...overrides.usage },
    threads: {
      queue: () => undefined,
      queuedPrompt: () => undefined,
      editQueued: () => ({ status: 'unknown_prompt' }),
      removeQueued: () => 'removed',
      resumeQueue: () => ({ status: 'missing' }),
      createThread: ({
        name,
        parentThreadId,
      }: {
        name: string;
        parentThreadId?: string;
      }) => ({
        status: 'created',
        thread: {
          ...thread,
          name,
          ...(parentThreadId ? { parentThreadId } : {}),
        },
      }),
      thread: (id: string) => (id === threadId ? thread : undefined),
      threads: () => ({ items: [] }),
      renameThread: ({ id, name }: ById & { name: string }) =>
        id === threadId ? { ...thread, name } : undefined,
      setThreadCwd: ({ id, cwd }: ById & { cwd: string }) =>
        id === threadId
          ? { status: 'updated', thread: { ...thread, cwd } }
          : { status: 'missing' },
      prompt: () => ({ status: 'accepted', promptId }),
      resume: ({ id, promptId: target }: ById & { promptId: string }) =>
        id === threadId && target === promptId
          ? { status: 'resumed', thread }
          : { status: 'missing' },
      rewind: ({ id }: ById) =>
        id === threadId
          ? { status: 'accepted', promptId }
          : { status: 'missing' },
      threadEvents: () => ({ events: [], lastSequence: 0 }),
      pause: ({ promptId: target }: { promptId: string }) =>
        target === promptId ? 'interrupted' : 'not_running',
      terminateThread: () => ({ ...thread, state: 'cancelled' }),
      deleteThread: () => 'active',
      ...overrides.threads,
    },
    terminal: { list: () => [], ...overrides.terminal },
  });

/** A feature read that ran on the Project's lease. */
const ready = (value: unknown) => ({ status: 'ready', value });

void test('queue editing returns full input and rejects invalid or stale writes', async (t) => {
  const prompt = { promptId, text: 'Full input', editable: true, revision: 7 };
  const host = await serve({
    threads: {
      queuedPrompt: () => prompt,
      editQueued: ({ text, revision }: { text: string; revision: number }) =>
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
  const stale = await host.request(path, 'PATCH', {
    text: 'Stale',
    revision: 6,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {
    error: {
      code: 'conflict',
      message:
        'This prompt was edited elsewhere. Your changes have not been saved.',
    },
  });
  for (const body of [
    { text: ' ', revision: 7 },
    { text: 'Missing revision' },
    { text: 'Bad revision', revision: -1 },
  ])
    assert.equal((await host.request(path, 'PATCH', body)).status, 422);
});

void test('answers each queue edit refusal with its unprefixed code and message', async (t) => {
  const cases = [
    ['missing', 404, 'This prompt is no longer available for editing.'],
    ['unknown_prompt', 404, 'This prompt is no longer available for editing.'],
    [
      'not_editable',
      409,
      'Only your prompts that have not started can be edited.',
    ],
    ['inactive', 409, 'This prompt is no longer available for editing.'],
    ['invalid_prompt', 409, 'This prompt is no longer available for editing.'],
  ] as const;
  for (const [status, expected, sentence] of cases) {
    const host = await serve({ threads: { editQueued: () => ({ status }) } });
    t.after(host.close);
    const response = await host.request(
      `/threads/${threadId}/queue/${promptId}`,
      'PATCH',
      { text: 'Edited', revision: 1 },
    );
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), {
      error: {
        code: status,
        message: `${sentence} Your changes have not been saved.`,
      },
    });
  }
});

void test('reads the queue without caching and maps resume outcomes', async (t) => {
  const queue = { revision: 12, paused: true, stopping: false, items: [] };
  const host = await serve({
    threads: {
      queue: (id: string) => (id === threadId ? queue : undefined),
      resumeQueue: (id: string) =>
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
    threads: { resumeQueue: () => ({ status: 'busy' }) },
  });
  t.after(stopping.close);
  assert.equal(
    (await stopping.request(`/threads/${threadId}/queue/resume`, 'POST'))
      .status,
    409,
  );
});

void test('answers a queue held for low storage with the storage message', async (t) => {
  const host = await serve({
    threads: { resumeQueue: () => ({ status: 'storage_low' }) },
  });
  t.after(host.close);
  const response = await host.request(
    `/threads/${threadId}/queue/resume`,
    'POST',
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'thread_storage_low',
      message:
        'Execution paused: storage is low or unavailable. Free disk space above 10% and resume the queue.',
    },
  });
});

void test('queue deletion validates prompt identity and refuses an input already running', async (t) => {
  const host = await serve({
    threads: {
      removeQueued: ({ id, promptId: target }: ById & { promptId: string }) =>
        id !== threadId ? 'missing' : target === promptId ? 'removed' : 'busy',
    },
  });
  t.after(host.close);
  assert.equal(
    (await host.request(`/threads/${threadId}/queue/${promptId}`, 'DELETE'))
      .status,
    204,
  );
  const busy = await host.request(
    `/threads/${threadId}/queue/${projectId}`,
    'DELETE',
  );
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as ErrorBody).error.code, 'thread_busy');
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

void test('answers a prompt no longer queued as an unknown prompt', async (t) => {
  const host = await serve();
  t.after(host.close);
  const response = await host.request(`/threads/${threadId}/queue/${promptId}`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'unknown_prompt',
      message: 'This prompt is no longer queued.',
    },
  });
  assert.equal(
    (await host.request(`/threads/${threadId}/queue/not-a-uuid`)).status,
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
    usage: {
      thread: (id: string) =>
        id === threadId ? { total, threads: [] } : undefined,
    },
  });
  t.after(host.close);
  const response = await host.request(`/threads/${threadId}/usage`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { total, threads: [] });
  assert.equal((await host.request(`/threads/${projectId}/usage`)).status, 404);
});

void test('maps separate Project and Thread creation and list results', async (t) => {
  const host = await serve({
    threads: { threads: () => ({ items: [thread] }) },
  });
  t.after(host.close);
  const created = await host.request('/projects', 'POST', {
    name: '  Project  ',
  });
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), {
    ...project,
    ssh: { href: `/projects/${projectId}/ssh` },
  });
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

void test('answers an unknown Project in Thread listing as missing', async (t) => {
  const host = await serve({ threads: { threads: () => undefined } });
  t.after(host.close);
  const response = await host.request(`/projects/${projectId}/threads`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: { code: 'project_not_found', message: 'The project was not found.' },
  });
});

void test('answers Project creation during host stop as an internal error', async (t) => {
  const host = await serve({
    runtime: {
      createProject: () => {
        throw new Error('Doric is shutting down.');
      },
    },
  });
  t.after(host.close);
  const response = await host.request('/projects', 'POST', { name: 'Late' });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'internal_error',
      message: 'The request could not be completed.',
    },
  });
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
  const received: unknown[] = [];
  const host = await serve({
    threads: {
      createThread: (input: { name: string; parentThreadId?: string }) => {
        received.push(input);
        return {
          status: 'created',
          thread: { ...thread, ...input },
        };
      },
    },
  });
  t.after(host.close);
  const child = await host.request(`/projects/${projectId}/threads`, 'POST', {
    name: 'Child',
    parentThreadId: threadId,
  });
  assert.equal(((await child.json()) as Thread).parentThreadId, threadId);
  assert.deepEqual(received, [
    { projectId, name: 'Child', parentThreadId: threadId },
  ]);
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
  const host = await serve();
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
  const host = await serve();
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
  const host = await serve();
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

void test('renames before it moves the working directory', async (t) => {
  const order: string[] = [];
  const host = await serve({
    threads: {
      renameThread: ({ name }: { name: string }) => {
        order.push('rename');
        return { ...thread, name };
      },
      setThreadCwd: ({ cwd }: { cwd: string }) => {
        order.push('cwd');
        return { status: 'inactive', cwd };
      },
    },
  });
  t.after(host.close);
  const response = await host.request(`/threads/${threadId}`, 'PATCH', {
    name: 'Renamed',
    cwd: 'alpha',
  });
  // The rename is not undone when the move is refused.
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'thread_inactive',
  );
  assert.deepEqual(order, ['rename', 'cwd']);
});

void test('returns 404 for missing rename targets and rejects invalid rename input', async (t) => {
  const host = await serve();
  t.after(host.close);
  assert.equal(
    (await host.request(`/projects/${promptId}`, 'PATCH', { name: 'Missing' }))
      .status,
    404,
  );
  assert.equal(
    (await host.request(`/threads/${promptId}`, 'PATCH', { name: 'Missing' }))
      .status,
    404,
  );
  assert.equal(
    (await host.request(`/projects/${projectId}`, 'PATCH', { name: ' ' }))
      .status,
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
  const missing = await serve({
    threads: { prompt: () => ({ status: 'missing' }) },
  });
  t.after(missing.close);
  assert.equal(
    (await missing.request(path, 'POST', { prompt: 'Do the work' })).status,
    404,
  );
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
    [
      'busy',
      409,
      'thread_busy',
      'The Thread is running or has queued input and cannot be rewound.',
    ],
    [
      'unknown_prompt',
      404,
      'prompt_not_found',
      'The prompt was not found in this Thread.',
    ],
    [
      'inactive',
      409,
      'thread_inactive',
      'The thread cannot perform this operation.',
    ],
  ] as const;
  for (const [status, expected, code, message] of cases) {
    const host = await serve({ threads: { rewind: () => ({ status }) } });
    t.after(host.close);
    const response = await host.request(`/threads/${threadId}/rewind`, 'POST', {
      promptId,
      prompt: 'Edited',
    });
    assert.equal(response.status, expected);
    assert.deepEqual(await response.json(), { error: { code, message } });
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
    ['storage_low', 409, 'thread_storage_low'],
  ] as const;
  for (const [status, expected, code] of cases) {
    const other = await serve({ threads: { resume: () => ({ status }) } });
    t.after(other.close);
    const response = await other.request(path, 'POST', { promptId });
    assert.equal(response.status, expected);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.code, code);
    assert.ok(body.error.message.length > 0);
  }
});

void test('requires prompt-scoped interruption and reports stale execution conflicts', async (t) => {
  const host = await serve();
  t.after(host.close);
  const path = `/threads/${threadId}/interrupt`;
  assert.equal((await host.request(path, 'POST')).status, 422);
  const stale = await host.request(path, 'POST', { promptId: projectId });
  assert.equal(stale.status, 409);
  assert.equal(
    ((await stale.json()) as ErrorBody).error.code,
    'thread_not_running',
  );
  const interrupted = await host.request(path, 'POST', { promptId });
  assert.equal(interrupted.status, 200);
  assert.deepEqual(await interrupted.json(), { status: 'interrupted' });
});

void test('forwards the replay cursor, prohibits caching and validates identifiers and pages', async (t) => {
  const host = await serve({
    threads: {
      threadEvents: ({
        id,
        afterSequence,
      }: ById & { afterSequence: number }) => {
        assert.equal(id, threadId);
        assert.equal(afterSequence, 1);
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
    body.events.map((event) => event.sequence),
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
      setThreadCwd: ({ id, cwd }: ById & { cwd: string }) => {
        if (id !== threadId) return { status: 'missing' };
        if (cwd === 'outside')
          return { status: 'refused', change: { status: 'outside' } };
        if (cwd === 'absent')
          return { status: 'refused', change: { status: 'missing' } };
        if (cwd === 'file')
          return { status: 'refused', change: { status: 'not-directory' } };
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

  for (const [cwd, message] of [
    ['outside', 'The working directory must stay inside the workspace.'],
    ['absent', 'No such directory.'],
    ['file', 'The working directory must be a directory.'],
  ] as const) {
    const refused = await host.request(`/threads/${threadId}`, 'PATCH', {
      cwd,
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), {
      error: { code: 'invalid_cwd', message },
    });
  }

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

void test('serves a Thread Git summary bound to the Thread and reports a missing or inactive Thread', async (t) => {
  const host = await serve({
    git: {
      status: (id: string) =>
        id === threadId
          ? ready({ repo: false })
          : id === promptId
            ? { status: 'inactive' }
            : { status: 'missing' },
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
  assert.equal((await host.request(`/threads/${projectId}/git`)).status, 404);
});

void test('serves pending Git and branch reads while refusing mutations without a lease', async (t) => {
  const host = await serve({
    git: {
      status: () => ({ status: 'pending' }),
      branches: () => ({ status: 'pending' }),
      switchBranch: () => ({ status: 'pending' }),
    },
  });
  t.after(host.close);
  for (const resource of ['git', 'branches']) {
    const response = await host.request(`/threads/${threadId}/${resource}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'pending' });
  }
  const refused = await host.request(`/threads/${threadId}/branches`, 'POST', {
    branch: 'main',
    cwd: '/workspace',
  });
  assert.equal(refused.status, 409);
  assert.equal(
    ((await refused.json()) as ErrorBody).error.code,
    'thread_inactive',
  );
});

void test('lists branches and reports switch refusals without accepting command options', async (t) => {
  const received: unknown[] = [];
  const host = await serve({
    git: {
      branches: (id: string) => {
        received.push({ branches: id });
        return ready({ branches: [] });
      },
      switchBranch: (input: unknown) => {
        received.push({ switchBranch: input });
        return { status: 'refused', message: 'Worktree is busy.' };
      },
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
  assert.deepEqual(await refused.json(), {
    error: { code: 'branch_refused', message: 'Worktree is busy.' },
  });
  assert.deepEqual(received, [
    { branches: threadId },
    { switchBranch: { threadId, branch: 'main', cwd: '/workspace' } },
  ]);
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
      assert.deepEqual(await response.json(), {
        error: {
          code: `invalid_${kind}_id`,
          message: `The ${kind} ID is invalid.`,
        },
      });
    }
  }
});

void test('reports missing resources and refuses active deletion', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const [kind, id] of [
    ['projects', projectId],
    ['threads', threadId],
  ] as const) {
    assert.equal((await host.request(`/${kind}/${promptId}`)).status, 404);
    const refused = await host.request(`/${kind}/${id}`, 'DELETE');
    assert.equal(refused.status, 409);
    assert.equal(
      ((await refused.json()) as ErrorBody).error.code,
      `${kind.slice(0, -1)}_active`,
    );
  }
});

void test('maps termination and successful deletion outcomes for Projects and Threads', async (t) => {
  const host = await serve({
    runtime: { deleteProject: () => 'deleted' },
    threads: { deleteThread: () => 'deleted' },
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
  const missing = await serve({
    runtime: { terminateProject: () => undefined },
    threads: { terminateThread: () => undefined },
  });
  t.after(missing.close);
  for (const kind of ['threads', 'projects'])
    assert.equal(
      (await missing.request(`/${kind}/${projectId}/terminate`, 'POST')).status,
      404,
    );
});

void test('returns private project SSH access and sanitizes unexpected failures', async (t) => {
  const host = await serve();
  t.after(host.close);
  const response = await host.request(`/projects/${projectId}/ssh`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    status: 'ready',
    vmId: 'vm-1',
    ssh: access,
    href: '/vms/vm-1/ssh',
  });
  const failed = await host.request(`/projects/${promptId}/ssh`);
  assert.equal(failed.status, 500);
  const failure = (await failed.json()) as ErrorBody;
  assert.deepEqual(failure, {
    error: {
      code: 'internal_error',
      message: 'The request could not be completed.',
    },
  });
  assert.doesNotMatch(JSON.stringify(failure), /secret provider credentials/);
});

for (const [status, expected] of [
  ['pending', 202],
  ['expired', 410],
  ['unavailable', 409],
  ['missing', 404],
] as const) {
  void test(`reports ${status} project SSH access without exposing or caching credentials`, async (t) => {
    const host = await serve({ lease: { ssh: () => ({ status }) } });
    t.after(host.close);
    const response = await host.request(`/projects/${projectId}/ssh`);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (status === 'pending')
      assert.equal(response.headers.get('retry-after'), '1');
    assert.equal('ssh' in ((await response.json()) as object), false);
  });
}

void test('binds every Project file read to the Project and forwards its path', async (t) => {
  const received: unknown[] = [];
  const record =
    (name: string, answer: unknown) => (input: unknown, call?: Call) => {
      // `project` takes no input: its only argument is the Call.
      const hop = (call ?? input) as Call;
      received.push({
        name,
        input: call === undefined ? undefined : input,
        scope: hop.scope,
      });
      return answer;
    };
  const host = await serve({
    files: {
      directory: record(
        'directory',
        ready({ status: 'listed', path: 'src', entries: [] }),
      ),
      tree: record('tree', ready({ status: 'listed', path: '', entries: [] })),
      content: record(
        'content',
        ready({
          status: 'read',
          path: 'a.ts',
          content: 'x',
          truncated: false,
          binary: false,
        }),
      ),
    },
    git: {
      diff: record(
        'diff',
        ready({ status: 'read', path: 'src', repositories: [] }),
      ),
      changes: record('changes', ready({ status: 'read', repositories: [] })),
      fileDiff: record('fileDiff', ready({ status: 'invalid_path' })),
    },
    resources: {
      project: record('project', ready({ status: 'unavailable', at: 'now' })),
    },
  });
  t.after(host.close);
  const base = `/projects/${projectId}`;
  assert.deepEqual(
    await (await host.request(`${base}/files?path=src`)).json(),
    {
      path: 'src',
      entries: [],
    },
  );
  assert.deepEqual(await (await host.request(`${base}/tree`)).json(), {
    path: '',
    entries: [],
  });
  assert.deepEqual(
    await (await host.request(`${base}/files/content?path=a.ts`)).json(),
    { path: 'a.ts', content: 'x', truncated: false, binary: false },
  );
  assert.deepEqual(await (await host.request(`${base}/diff?path=src`)).json(), {
    path: 'src',
    repositories: [],
  });
  assert.deepEqual(await (await host.request(`${base}/changes`)).json(), {
    repositories: [],
  });
  const fileDiff = await host.request(
    `${base}/files/diff?repository=.&path=a.ts`,
  );
  assert.equal(fileDiff.status, 422);
  assert.deepEqual(await fileDiff.json(), {
    error: {
      code: 'invalid_project_path',
      message: 'The changed file cannot be read.',
    },
  });
  assert.deepEqual(await (await host.request(`${base}/resources`)).json(), {
    status: 'unavailable',
    at: 'now',
  });
  const scope = { projectId };
  assert.deepEqual(received, [
    { name: 'directory', input: { path: 'src' }, scope },
    { name: 'tree', input: {}, scope },
    { name: 'content', input: { path: 'a.ts' }, scope },
    { name: 'diff', input: { path: 'src' }, scope },
    { name: 'changes', input: {}, scope },
    { name: 'fileDiff', input: { repository: '.', path: 'a.ts' }, scope },
    { name: 'project', input: undefined, scope },
  ]);
});

/** Every Project read of the feature bundles answering the same outcome. */
const everyRead = (answer: () => unknown): Fakes => ({
  files: { directory: answer, tree: answer, content: answer },
  git: { diff: answer, changes: answer, fileDiff: answer },
  resources: { project: answer },
});

void test('answers the shared lease states on every Project file read', async (t) => {
  const reads = [
    'files',
    'tree',
    'files/content?path=a',
    'diff',
    'changes',
    'files/diff?repository=.&path=a',
    'resources',
  ];
  const cases = [
    ['missing', 404, 'project_not_found', 'The project was not found.'],
    [
      'expired',
      410,
      'project_files_expired',
      'The Project file access has expired.',
    ],
    [
      'unavailable',
      409,
      'project_files_unavailable',
      'The project cannot perform this operation.',
    ],
  ] as const;
  for (const [status, expected, code, message] of cases) {
    const answer = () => ({ status });
    const host = await serve(everyRead(answer));
    t.after(host.close);
    for (const read of reads) {
      const response = await host.request(`/projects/${projectId}/${read}`);
      assert.equal(response.status, expected, read);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: { code, message } });
    }
  }
  const pending = () => ({ status: 'pending' });
  const host = await serve(everyRead(pending));
  t.after(host.close);
  for (const read of reads) {
    const response = await host.request(`/projects/${projectId}/${read}`);
    assert.equal(response.status, 202, read);
    assert.equal(response.headers.get('retry-after'), '1');
    assert.deepEqual(await response.json(), { status: 'pending' });
  }
});

void test('answers each Project path refusal with its own message', async (t) => {
  const host = await serve({
    files: {
      directory: () => ready({ status: 'not_directory' }),
      tree: () => ready({ status: 'not_found' }),
      content: () => ready({ status: 'not_file' }),
    },
    git: {
      diff: () => ready({ status: 'invalid_path' }),
      changes: () => ready({ status: 'not_found' }),
      fileDiff: () => ready({ status: 'not_found' }),
    },
  });
  t.after(host.close);
  const base = `/projects/${projectId}`;
  for (const [path, status, code, message] of [
    [
      'files',
      422,
      'invalid_project_path',
      'The Project path is not a directory.',
    ],
    ['tree', 404, 'project_path_not_found', 'The Project path was not found.'],
    [
      'files/content?path=a',
      422,
      'invalid_project_path',
      'The Project path is not a readable file.',
    ],
    ['diff', 422, 'invalid_project_path', 'The Project path is invalid.'],
    [
      'changes',
      404,
      'project_path_not_found',
      'The Project path cannot be read.',
    ],
    [
      'files/diff?repository=.&path=a',
      404,
      'project_path_not_found',
      'The changed file cannot be read.',
    ],
    [
      'files/content',
      422,
      'invalid_project_path',
      'The Project path is invalid.',
    ],
    [
      'files/diff?repository=.',
      422,
      'invalid_project_path',
      'The Project path is invalid.',
    ],
  ] as const) {
    const response = await host.request(`${base}/${path}`);
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { error: { code, message } });
  }
});

void test('rejects cross-project parenting and inputs into inactive threads', async (t) => {
  const host = await serve({
    threads: {
      createThread: () => ({ status: 'invalid_parent' }),
      prompt: () => ({ status: 'inactive' }),
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
  for (const [status, expected, code] of [
    ['missing', 404, 'project_not_found'],
    ['inactive', 409, 'thread_inactive'],
  ] as const) {
    const other = await serve({
      threads: { createThread: () => ({ status }) },
    });
    t.after(other.close);
    const response = await other.request(
      `/projects/${projectId}/threads`,
      'POST',
      { name: 'Child' },
    );
    assert.equal(response.status, expected);
    assert.equal(((await response.json()) as ErrorBody).error.code, code);
  }
});

void test('forwards pagination cursors and parent filters and preserves the next cursor', async (t) => {
  const received: unknown[] = [];
  const host = await serve({
    runtime: {
      projects: (page: unknown) => {
        received.push(page);
        return { items: [project], nextCursor: projectId };
      },
    },
    threads: {
      threads: (input: {
        limit: number;
        cursor?: string;
        parentThreadId?: string;
      }) => {
        received.push(input);
        return {
          items: [{ ...thread, parentThreadId: input.parentThreadId }],
          ...(input.limit === 100 && input.cursor === promptId
            ? { nextCursor: threadId }
            : {}),
        };
      },
    },
  });
  t.after(host.close);
  const response = await host.request(
    `/projects/${projectId}/threads?limit=100&cursor=${promptId}&parentThreadId=${projectId}`,
  );
  const page = (await response.json()) as Page<Thread>;
  assert.equal(page.items[0]?.parentThreadId, projectId);
  assert.equal(page.nextCursor, threadId);
  const projects = (await (
    await host.request('/projects')
  ).json()) as Page<Project>;
  assert.equal(projects.nextCursor, projectId);
  assert.deepEqual(received, [
    {
      projectId,
      limit: 100,
      cursor: promptId,
      parentThreadId: projectId,
    },
    { limit: 50 },
  ]);
});
