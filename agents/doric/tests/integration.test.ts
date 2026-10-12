import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { defaultConfig } from 'host-config/testing';
import { io } from 'socket.io-client';

import { freshDatabase, startHostProcess } from './helpers/host.js';
import {
  childPrompt,
  childResult,
  followup,
  heldAnswer,
  heldPrompt,
  marker,
  parentPrompt,
  scriptedEndpoint,
  scriptedModel,
  secondPrompt,
} from './helpers/integration-provider.js';
import { cleanupStack } from './helpers/persistence-fixture.js';
import { inbox } from './helpers/socket-inbox.js';

// The full host: the compiled kernel with its staged bundles, the runtime and
// Direct in the generation process, PostgreSQL and a real Docker sandbox.
// Only the model endpoint is scripted; tools, storage, the transport and the
// sandbox are real. Build doric first. Ported from the former
// workspace-integration test (design 57 §13.2).

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const enabled = connectionString && process.env.DORIC_TEST_SANDBOX === 'true';

interface Project {
  readonly id: string;
  readonly state: string;
}
interface Thread {
  readonly id: string;
  readonly state: string;
  readonly lastSequence: number;
}
interface ThreadEvent {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
}
interface Completion {
  readonly status: string;
  readonly text: string;
  readonly source: {
    readonly kind: string;
    readonly threadId?: string;
    readonly promptId?: string;
    readonly requestPromptId?: string;
  };
}
const completion = (event: ThreadEvent) => event.event as Completion;

void test('delegates across isolated conversations sharing a real project sandbox and durable API events', {
  skip: enabled
    ? false
    : 'Requires DORIC_TEST_DATABASE_URL and DORIC_TEST_SANDBOX=true',
  timeout: 300_000,
}, async (t) => {
  assert.ok(connectionString);
  const cleanup = cleanupStack();
  t.after(() => cleanup.close());
  const database = await freshDatabase(connectionString);
  cleanup.defer(database.close);
  const model = await scriptedEndpoint();
  cleanup.defer(model.close);
  const host = await startHostProcess(
    { DORIC_DATABASE_URL: database.url },
    { timeoutMs: 120_000 },
  );
  cleanup.defer(host.close);

  const request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200,
  ): Promise<T> => {
    const response = await host.request(path, method, body);
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${await response.clone().text()}`,
    );
    return status === 204 ? (undefined as T) : ((await response.json()) as T);
  };
  const subscribe = (
    namespace: string,
    auth: Record<string, string | number>,
  ) => {
    const socket = io(`${host.url}/${namespace}`, {
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
      forceNew: true,
      auth,
    });
    cleanup.defer(async () => socket.close());
    const notices = inbox(socket);
    socket.connect();
    return notices;
  };

  // The operator's setup: a credential, then a configuration against the
  // scripted endpoint, whose catalog the replacement reads.
  const credential = await request<{ id: string }>(
    '/credentials',
    'POST',
    { kind: 'API_TOKEN', name: 'scripted', secret: 'sk-scripted' },
    201,
  );
  await request('/config', 'PUT', {
    ...defaultConfig,
    providers: [
      {
        id: 'scripted',
        kind: 'openrouter',
        configuration: { endpoint: model.endpoint, token: credential.id },
        models: [{ name: scriptedModel, reasonings: [] }],
      },
    ],
    models: { execution: { providerId: 'scripted', model: scriptedModel } },
  });

  const project = await request<Project>(
    '/projects',
    'POST',
    { name: 'Integration project' },
    202,
  );
  const projectSocket = subscribe('projects', { projectId: project.id });
  const snapshot = await projectSocket.wait<{
    project: Project;
    threads: Thread[];
  }>('project:snapshot');
  assert.deepEqual(snapshot.threads, []);
  if (snapshot.project.state !== 'ready') {
    await projectSocket.wait<Project>(
      'project:updated',
      (value) => value.state === 'ready',
      180_000,
    );
  }
  const root = await request<Thread>(
    `/projects/${project.id}/threads`,
    'POST',
    { name: 'Root thread' },
    201,
  );
  const rootSocket = subscribe('threads', { threadId: root.id });
  await rootSocket.wait('thread:snapshot');
  const prompt = await request<{ promptId: string }>(
    `/threads/${root.id}/prompt`,
    'POST',
    { prompt: parentPrompt },
    202,
  );
  const resumed = await rootSocket.wait<ThreadEvent>(
    'agent:event',
    (value) =>
      value.type === 'prompt.finished' &&
      completion(value).source.kind === 'result',
    120_000,
  );
  assert.deepEqual(model.failures, []);
  assert.equal(completion(resumed).status, 'completed');
  assert.equal(completion(resumed).text, 'Parent verified the shared file.');
  const source = completion(resumed).source;
  assert.equal(source.requestPromptId, prompt.promptId);
  const children = await request<{ items: Thread[] }>(
    `/projects/${project.id}/threads?parentThreadId=${root.id}`,
  );
  assert.equal(children.items.length, 1);
  const child = children.items[0];
  assert.ok(child !== undefined);
  assert.equal(source.threadId, child.id);
  const childEvents = await request<{ events: ThreadEvent[] }>(
    `/threads/${child.id}/events`,
  );
  const childDone = childEvents.events.find(
    (value) => value.type === 'prompt.finished',
  );
  assert.ok(childDone);
  assert.equal(childDone.promptId, source.promptId);
  assert.deepEqual(completion(childDone).source, {
    kind: 'parent',
    threadId: root.id,
    promptId: prompt.promptId,
  });
  assert.equal(completion(childDone).status, 'completed');
  assert.ok(childEvents.events.some(({ type }) => type === 'tool.finished'));
  // The parent's queue.updated follows prompt.finished, and ready follows it, so
  // this barrier makes the log below complete rather than racing its last event.
  await rootSocket.wait<Thread>(
    'thread:updated',
    (value) => value.state === 'ready' && value.lastSequence > resumed.sequence,
  );

  // REST, live delivery, and exclusive-cursor reconnect replay describe the same durable records.
  const rootEvents = await request<{ events: ThreadEvent[] }>(
    `/threads/${root.id}/events`,
  );
  assert.deepEqual(
    rootSocket.values<ThreadEvent>('agent:event'),
    rootEvents.events,
  );
  const cursor = rootEvents.events[1]?.sequence;
  assert.ok(cursor !== undefined);
  const replay = subscribe('threads', {
    threadId: root.id,
    afterSequence: cursor,
  });
  const replayed = await replay.wait<{ events: ThreadEvent[] }>(
    'thread:snapshot',
  );
  const restReplay = await request<{ events: ThreadEvent[] }>(
    `/threads/${root.id}/events?afterSequence=${cursor}`,
  );
  assert.deepEqual(replayed.events, restReplay.events);
  assert.ok(
    replayed.events.every(
      (value) =>
        value.projectId === project.id &&
        value.threadId === root.id &&
        value.sequence > cursor,
    ),
  );

  const childSocket = subscribe('threads', { threadId: child.id });
  await childSocket.wait('thread:snapshot');
  const human = await request<{ promptId: string }>(
    `/threads/${child.id}/prompt`,
    'POST',
    { prompt: followup },
    202,
  );
  const humanDone = await childSocket.wait<ThreadEvent>(
    'agent:event',
    (value) =>
      value.type === 'prompt.finished' && value.promptId === human.promptId,
  );
  assert.equal(completion(humanDone).status, 'completed');
  assert.deepEqual(completion(humanDone).source, { kind: 'user' });
  // ready follows result-routing, so this is a barrier rather than a timing-based negative assertion.
  await childSocket.wait<Thread>(
    'thread:updated',
    (value) =>
      value.state === 'ready' && value.lastSequence >= humanDone.sequence,
  );
  assert.deepEqual(
    (await request<{ events: ThreadEvent[] }>(`/threads/${root.id}/events`))
      .events,
    rootEvents.events,
  );

  const sibling = await request<Thread>(
    `/projects/${project.id}/threads`,
    'POST',
    { name: 'Sibling thread' },
    201,
  );
  const siblingSocket = subscribe('threads', { threadId: sibling.id });
  await siblingSocket.wait('thread:snapshot');
  const second = await request<{ promptId: string }>(
    `/threads/${sibling.id}/prompt`,
    'POST',
    { prompt: secondPrompt },
    202,
  );
  const secondDone = await siblingSocket.wait<ThreadEvent>(
    'agent:event',
    (value) =>
      value.type === 'prompt.finished' && value.promptId === second.promptId,
    120_000,
  );
  assert.equal(completion(secondDone).status, 'completed');
  assert.equal(
    completion(secondDone).text,
    'Independent root verified the shared file.',
  );
  // One sandbox served the Project's three Threads.
  assert.equal((await request<unknown[]>('/vms')).length, 1);

  // Each conversation's model history is its own: what the endpoint saw.
  const seen = (text: string) =>
    model.requests.filter(({ messages }) =>
      JSON.stringify(messages).includes(text),
    );
  assert.ok(seen(parentPrompt).length > 0);
  assert.ok(seen(followup).length > 0);
  assert.ok(
    seen(followup).every(
      ({ messages }) => !JSON.stringify(messages).includes(parentPrompt),
    ),
  );
  assert.ok(
    seen(secondPrompt).every(
      ({ messages }) =>
        !JSON.stringify(messages).includes(parentPrompt) &&
        !JSON.stringify(messages).includes(followup),
    ),
  );
  assert.ok(seen(childPrompt).length > 0);
  assert.ok(seen(childResult).length > 0);
  assert.ok(seen(marker).length > 0);
  assert.deepEqual(model.failures, []);

  await request(`/projects/${project.id}/terminate`, 'POST', {});
  await projectSocket.wait<Project>(
    'project:updated',
    (value) => value.state === 'cancelled',
    120_000,
  );
  for (const thread of [root, child, sibling]) {
    assert.equal(
      (await request<Thread>(`/threads/${thread.id}`)).state,
      'cancelled',
    );
  }
  await request(`/projects/${project.id}`, 'DELETE', undefined, 204);
  await request(`/projects/${project.id}`, 'GET', undefined, 404);
  for (const thread of [root, child, sibling])
    await request(`/threads/${thread.id}`, 'GET', undefined, 404);

  assert.equal(await host.stop(), 0);
});

/** The generation processes the host forked: its children running the runner. */
const generationPids = (hostPid: number): number[] =>
  execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter(
      ([, ppid, ...command]) =>
        ppid === String(hostPid) && command.join(' ').includes('runner-main'),
    )
    .map(([pid]) => Number(pid));

void test('a generation process that dies under a running prompt pauses it, and the respawned one resumes it', {
  skip: enabled
    ? false
    : 'Requires DORIC_TEST_DATABASE_URL and DORIC_TEST_SANDBOX=true',
  timeout: 300_000,
}, async (t) => {
  assert.ok(connectionString);
  const cleanup = cleanupStack();
  t.after(() => cleanup.close());
  const database = await freshDatabase(connectionString);
  cleanup.defer(database.close);
  const model = await scriptedEndpoint();
  cleanup.defer(model.close);
  const host = await startHostProcess(
    { DORIC_DATABASE_URL: database.url },
    { timeoutMs: 120_000 },
  );
  cleanup.defer(host.close);
  const request = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    status = 200,
  ): Promise<T> => {
    const response = await host.request(path, method, body);
    assert.equal(
      response.status,
      status,
      `${method} ${path}: ${await response.clone().text()}`,
    );
    return (await response.json()) as T;
  };
  const credential = await request<{ id: string }>(
    '/credentials',
    'POST',
    { kind: 'API_TOKEN', name: 'scripted', secret: 'sk-scripted' },
    201,
  );
  await request('/config', 'PUT', {
    ...defaultConfig,
    providers: [
      {
        id: 'scripted',
        kind: 'openrouter',
        configuration: { endpoint: model.endpoint, token: credential.id },
        models: [{ name: scriptedModel, reasonings: [] }],
      },
    ],
    models: { execution: { providerId: 'scripted', model: scriptedModel } },
  });
  const project = await request<Project>(
    '/projects',
    'POST',
    { name: 'Respawn project' },
    202,
  );
  for (let attempt = 0; ; attempt += 1) {
    const state = (await request<Project>(`/projects/${project.id}`)).state;
    if (state === 'ready') break;
    assert.ok(attempt < 900 && state !== 'failed', `Project ${state}`);
    await delay(200);
  }
  const thread = await request<Thread>(
    `/projects/${project.id}/threads`,
    'POST',
    { name: 'Respawn thread' },
    201,
  );
  const prompt = await request<{ promptId: string }>(
    `/threads/${thread.id}/prompt`,
    'POST',
    { prompt: heldPrompt },
    202,
  );
  await model.held;

  const assertedPid = host.child.pid;
  assert.ok(assertedPid !== undefined);
  const [lost] = generationPids(assertedPid);
  assert.ok(lost !== undefined, 'the host runs a generation process');
  process.kill(lost, 'SIGKILL');

  // A request in flight when the process dies fails with it; the cases
  // read the host once the kernel has seen the loss and respawned.
  for (let attempt = 0; ; attempt += 1) {
    const pids = generationPids(assertedPid);
    if (pids.length > 0 && !pids.includes(lost)) break;
    assert.ok(attempt < 300, 'the generation process was never respawned');
    await delay(100);
  }

  let events: readonly ThreadEvent[] = [];
  for (let attempt = 0; ; attempt += 1) {
    events = (
      await request<{ events: ThreadEvent[] }>(`/threads/${thread.id}/events`)
    ).events.filter(({ promptId }) => promptId === prompt.promptId);
    if (events.some(({ type }) => type === 'prompt.finished')) break;
    assert.ok(attempt < 600, JSON.stringify(events));
    await delay(200);
  }

  const paused = events.find(({ type }) => type === 'prompt.paused');
  assert.deepEqual(paused?.event, {
    type: 'prompt.paused',
    reason: 'host_restarted',
  });
  const finished = events.find(({ type }) => type === 'prompt.finished');
  assert.ok(finished !== undefined);
  assert.equal(completion(finished).status, 'completed');
  assert.equal(completion(finished).text, heldAnswer);
  assert.ok(events.indexOf(paused as ThreadEvent) < events.indexOf(finished));
  // A new process serves the host now, and the prompt reached the model twice.
  assert.ok(!generationPids(assertedPid).includes(lost));
  assert.equal(
    model.requests.filter(({ messages }) =>
      JSON.stringify(messages).includes(heldPrompt),
    ).length,
    2,
  );
  assert.deepEqual(model.failures, []);

  assert.equal(await host.stop(), 0);
});
