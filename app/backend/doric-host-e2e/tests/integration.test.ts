import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { defaultConfig } from 'host-config/testing';

import {
  ApiError,
  callApi,
  openStream,
  reasonOf,
} from '../../doric-host/tests/helpers/api.js';
import {
  freshDatabase,
  startHostProcess,
} from '../../doric-host/tests/helpers/host.js';
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
} from '../../doric-host/tests/helpers/integration-provider.js';
import { cleanupStack } from '../../doric-host/tests/helpers/persistence-fixture.js';
import { bundlePid } from '../../doric-host/tests/helpers/processes.js';

// The full host: the compiled platform host with its staged bundles, each a
// process of its own, PostgreSQL and a real Docker sandbox. Only the model
// endpoint is scripted; tools, storage, the transport and the sandbox are
// real. A client reaches the host as any client outside it does: the public
// `doric.api.*` services, Connect JSON over `fetch` (AC3.2, T3.1). Build
// doric-host first.

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const enabled = connectionString && process.env.DORIC_TEST_SANDBOX === 'true';
const skip = enabled
  ? false
  : 'Requires DORIC_TEST_DATABASE_URL and DORIC_TEST_SANDBOX=true';
const bundlesPath = 'app/backend/doric-host/dist/bundles';

interface Project {
  readonly id: string;
  readonly state: string;
  /** Why the Project failed; absent unless it failed. */
  readonly errorCode?: string;
}
interface Thread {
  readonly id: string;
  readonly state: string;
  readonly lastSequence?: number;
  /** The working directory, absolute in the sandbox. */
  readonly cwd?: string;
  /** The repository at `cwd` itself: "git" or "github"; absent when none. */
  readonly cwdRepo?: string;
}
/** `doric.terminal.v1.TerminalSession`, the fields read here. */
interface TerminalSession {
  readonly id: string;
  readonly state: string;
}
interface ThreadEvent {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId?: string;
  readonly sequence: number;
  readonly type: string;
  readonly event?: unknown;
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
/** One item of `ProjectsService/Watch`. */
interface ProjectItem {
  readonly projectSnapshot?: {
    readonly project?: Project;
    readonly threads?: readonly Thread[];
  };
  readonly terminalSnapshot?: unknown;
  readonly projectUpdated?: Project;
}
/** One item of `ThreadsService/Watch`. */
interface ThreadItem {
  readonly threadSnapshot?: { readonly events?: readonly ThreadEvent[] };
  readonly agentEvent?: ThreadEvent;
  readonly threadUpdated?: Thread;
}
const completion = (event: ThreadEvent) => event.event as Completion;
const finishedOf = (item: ThreadItem) =>
  item.agentEvent?.type === 'prompt.finished' ? item.agentEvent : undefined;

/**
 * One request per public RPC whose route refuses an invalid input today
 * (`transport`'s `apiViolations`, its test `router-violations.test.ts`): the
 * request breaks one protovalidate rule, and the gateway answers HTTP 400,
 * Connect code `invalid_argument`, with `reason` as its ErrorInfo reason.
 * Written as literals here, not imported from `transport`.
 */
interface InvalidRequest {
  /** `doric.api.<resource>.v1.<Service>/<Method>`. */
  readonly procedure: string;
  readonly request: Record<string, unknown>;
  readonly reason: string;
}

/** A well-formed id no record holds: a body rule is the only one broken. */
const id = '5f0c2d4e-8a1b-4c3d-9e2f-1a2b3c4d5e6f';
const notId = 'not-a-uuid';
const config = 'doric.api.config.v1.ConfigService';
const credentials = 'doric.api.credentials.v1.CredentialsService';
const providers = 'doric.api.providers.v1.ProvidersService';
const projects = 'doric.api.projects.v1.ProjectsService';
const threads = 'doric.api.threads.v1.ThreadsService';
const terminals = 'doric.api.terminals.v1.TerminalsService';

const invalidRequests: readonly InvalidRequest[] = [
  { procedure: `${config}/PutConfig`, request: {}, reason: 'invalid_config' },
  {
    procedure: `${credentials}/CreateCredential`,
    request: { kind: 'api_token', name: 'scripted', secret: 'sk' },
    reason: 'invalid_credential',
  },
  {
    procedure: `${credentials}/UpdateCredential`,
    request: { credentialId: id, kind: 'api_token' },
    reason: 'invalid_credential',
  },
  {
    procedure: `${credentials}/DeleteCredential`,
    request: { credentialId: notId },
    reason: 'invalid_credential_id',
  },
  {
    procedure: `${providers}/ListModels`,
    request: { kind: ' ' },
    reason: 'invalid_provider',
  },
  {
    procedure: `${projects}/CreateProject`,
    request: { name: '' },
    reason: 'invalid_project',
  },
  {
    procedure: `${projects}/UpdateProject`,
    request: { projectId: id, name: '' },
    reason: 'invalid_project',
  },
  {
    procedure: `${projects}/ListProjects`,
    request: { limit: 0 },
    reason: 'invalid_page',
  },
  {
    procedure: `${projects}/ListThreads`,
    request: { projectId: id, limit: 101 },
    reason: 'invalid_page',
  },
  {
    procedure: `${projects}/SetProjectColor`,
    request: { projectId: id, color: 'black' },
    reason: 'invalid_project_color',
  },
  {
    procedure: `${projects}/CreateThread`,
    request: { projectId: id, name: '' },
    reason: 'invalid_thread',
  },
  ...['ListFiles', 'GetTree', 'GetDiff', 'ListChanges'].map(
    (method): InvalidRequest => ({
      procedure: `${projects}/${method}`,
      request: { projectId: id, path: 'a\u0000b' },
      reason: 'invalid_project_path',
    }),
  ),
  {
    procedure: `${projects}/GetFileDiff`,
    request: { projectId: id, repository: '', path: '' },
    reason: 'invalid_project_path',
  },
  ...[
    'GetProject',
    'GetProjectSsh',
    'GetProjectResources',
    'TerminateProject',
    'DeleteProject',
  ].map(
    (method): InvalidRequest => ({
      procedure: `${projects}/${method}`,
      request: { projectId: notId },
      reason: 'invalid_project_id',
    }),
  ),
  {
    procedure: `${threads}/UpdateThread`,
    request: { threadId: id },
    reason: 'invalid_thread',
  },
  {
    procedure: `${threads}/CreateBranch`,
    request: { threadId: id, branch: '-feature', cwd: '/workspace' },
    reason: 'invalid_branch',
  },
  {
    procedure: `${threads}/Prompt`,
    request: { threadId: id, prompt: ' ' },
    reason: 'invalid_prompt',
  },
  {
    procedure: `${threads}/Steer`,
    request: { threadId: id, prompt: 'Go on.', promptId: notId },
    reason: 'invalid_steer',
  },
  {
    procedure: `${threads}/Resume`,
    request: { threadId: id, promptId: notId },
    reason: 'invalid_resume',
  },
  {
    procedure: `${threads}/Interrupt`,
    request: { threadId: id, promptId: notId },
    reason: 'invalid_interrupt',
  },
  {
    procedure: `${threads}/Rewind`,
    request: { threadId: id, promptId: id, prompt: ' ' },
    reason: 'invalid_rewind',
  },
  {
    procedure: `${threads}/ListEvents`,
    request: { threadId: id, afterSequence: 1.5 },
    reason: 'invalid_event_cursor',
  },
  ...['GetQueuedPrompt', 'DeleteQueuedPrompt'].map(
    (method): InvalidRequest => ({
      procedure: `${threads}/${method}`,
      request: { threadId: id, promptId: notId },
      reason: 'invalid_prompt',
    }),
  ),
  {
    procedure: `${threads}/UpdateQueuedPrompt`,
    request: { threadId: id, promptId: id, text: 'Later.', revision: -1 },
    reason: 'invalid_prompt',
  },
  ...[
    'GetThread',
    'GetGit',
    'ListBranches',
    'Compact',
    'GetUsage',
    'GetQueue',
    'ResumeQueue',
    'TerminateThread',
    'DeleteThread',
  ].map(
    (method): InvalidRequest => ({
      procedure: `${threads}/${method}`,
      request: { threadId: notId },
      reason: 'invalid_thread_id',
    }),
  ),
  {
    procedure: `${threads}/CreateTerminal`,
    request: { threadId: id, cols: 0 },
    reason: 'invalid_terminal',
  },
  {
    procedure: `${terminals}/GetTerminal`,
    request: { terminalId: 'terminal', after: -1 },
    reason: 'invalid_cursor',
  },
  {
    procedure: `${terminals}/SendInput`,
    request: { terminalId: 'terminal', data: 'x'.repeat(65_537) },
    reason: 'invalid_input',
  },
  {
    procedure: `${terminals}/Resize`,
    request: { terminalId: 'terminal', cols: 0, rows: 24 },
    reason: 'invalid_size',
  },
];

/**
 * The refusing RPCs that are server streams: Connect answers their refusal in
 * the stream's end message (HTTP 200), so the same code and reason arrive
 * there instead of in a 400.
 */
const invalidStreams: readonly InvalidRequest[] = [
  {
    procedure: `${projects}/ReadFile`,
    request: { projectId: id, path: 'a\u0000b' },
    reason: 'invalid_project_path',
  },
  {
    procedure: `${projects}/Watch`,
    request: { projectId: notId },
    reason: 'invalid_input',
  },
  {
    procedure: `${threads}/Watch`,
    request: { threadId: notId },
    reason: 'invalid_input',
  },
];

/** The {@link ApiError} `call` rejects with; fails the test when it answers. */
const refusal = async (call: Promise<unknown>): Promise<ApiError> => {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof ApiError, String(error));
    return error;
  }
  return assert.fail('the call was answered');
};

/** A fresh database, the scripted model and the host process on them. */
const startFixture = async (t: TestContext) => {
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
  const api = <T = Record<string, unknown>>(
    procedure: string,
    request: unknown = {},
  ) => callApi<T>(host.url, `doric.api.${procedure}`, request);
  const watch = async <T>(procedure: string, request: unknown) => {
    const stream = await openStream<T>(
      host.url,
      `doric.api.${procedure}`,
      request,
    );
    cleanup.defer(async () => stream.close());
    return stream;
  };
  /** Every event of the Thread after `afterSequence`, following the pages. */
  const listEvents = async (threadId: string, afterSequence?: number) => {
    const events: ThreadEvent[] = [];
    let cursor = afterSequence;
    for (;;) {
      const page = await api<{
        threadEventLog?: { events?: ThreadEvent[] };
        nextAfterSequence?: number;
      }>('threads.v1.ThreadsService/ListEvents', {
        threadId,
        ...(cursor === undefined ? {} : { afterSequence: cursor }),
      });
      events.push(...(page.threadEventLog?.events ?? []));
      if (page.nextAfterSequence === undefined) return events;
      cursor = page.nextAfterSequence;
    }
  };

  // The operator's setup: a credential, then a configuration against the
  // scripted endpoint, whose catalog the replacement reads.
  const configure = async () => {
    const credential = await api<{ credentialDescription: { id: string } }>(
      'credentials.v1.CredentialsService/CreateCredential',
      { kind: 'API_TOKEN', name: 'scripted', secret: 'sk-scripted' },
    );
    await api('config.v1.ConfigService/PutConfig', {
      configuration: {
        ...defaultConfig,
        providers: [
          {
            id: 'scripted',
            kind: 'openrouter',
            configuration: {
              endpoint: model.endpoint,
              token: credential.credentialDescription.id,
            },
            models: [{ name: scriptedModel, reasonings: [] }],
          },
        ],
        models: {
          execution: { providerId: 'scripted', model: scriptedModel },
        },
      },
    });
  };

  return { model, host, api, watch, listEvents, configure };
};

void test('delegates across isolated conversations sharing a real project sandbox and durable API events', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const { model, host, api, watch, listEvents, configure } =
    await startFixture(t);
  await configure();

  const { project } = await api<{ project: Project }>(
    'projects.v1.ProjectsService/CreateProject',
    { name: 'Integration project' },
  );
  const projectWatch = await watch<ProjectItem>(
    'projects.v1.ProjectsService/Watch',
    { projectId: project.id },
  );
  const snapshot = (await projectWatch.next()).projectSnapshot;
  assert.ok(snapshot !== undefined, 'the first item is the projectSnapshot');
  assert.deepEqual(snapshot.threads ?? [], []);
  assert.ok(
    (await projectWatch.next()).terminalSnapshot !== undefined,
    'the second item is the terminalSnapshot',
  );
  if (snapshot.project?.state === 'failed') {
    assert.fail(
      `Project failed: ${snapshot.project.errorCode ?? 'no errorCode'}`,
    );
  }
  if (snapshot.project?.state !== 'ready') {
    const settled = (
      await projectWatch.until(
        (item) =>
          item.projectUpdated?.state === 'ready' ||
          item.projectUpdated?.state === 'failed',
        180_000,
      )
    ).projectUpdated;
    assert.equal(
      settled?.state,
      'ready',
      `Project failed: ${settled?.errorCode ?? 'no errorCode'}`,
    );
  }

  const { thread: root } = await api<{ thread: Thread }>(
    'projects.v1.ProjectsService/CreateThread',
    { projectId: project.id, name: 'Root thread' },
  );
  const rootWatch = await watch<ThreadItem>('threads.v1.ThreadsService/Watch', {
    threadId: root.id,
  });
  assert.ok((await rootWatch.next()).threadSnapshot !== undefined);
  const prompt = await api<{ promptId: string }>(
    'threads.v1.ThreadsService/Prompt',
    { threadId: root.id, prompt: parentPrompt },
  );
  const resumed = finishedOf(
    await rootWatch.until((item) => {
      const finished = finishedOf(item);
      return (
        finished !== undefined && completion(finished).source.kind === 'result'
      );
    }, 120_000),
  );
  assert.ok(resumed !== undefined);
  assert.deepEqual(model.failures, []);
  assert.equal(completion(resumed).status, 'completed');
  assert.equal(completion(resumed).text, 'Parent verified the shared file.');
  const source = completion(resumed).source;
  assert.equal(source.requestPromptId, prompt.promptId);
  const children = await api<{ threadPage: { items?: Thread[] } }>(
    'projects.v1.ProjectsService/ListThreads',
    { projectId: project.id, parentThreadId: root.id },
  );
  assert.equal(children.threadPage.items?.length, 1);
  const child = children.threadPage.items?.[0];
  assert.ok(child !== undefined);
  assert.equal(source.threadId, child.id);
  const childEvents = await listEvents(child.id);
  const childDone = childEvents.find(
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
  assert.ok(childEvents.some(({ type }) => type === 'tool.finished'));
  // The parent's queue.updated follows prompt.finished, and ready follows it, so
  // this barrier makes the log below complete rather than racing its last event.
  await rootWatch.until(
    ({ threadUpdated }) =>
      threadUpdated?.state === 'ready' &&
      (threadUpdated.lastSequence ?? 0) > resumed.sequence,
  );

  // ListEvents, live delivery, and the exclusive-cursor replay of a new Watch
  // describe the same durable records.
  const rootEvents = await listEvents(root.id);
  assert.deepEqual(
    rootWatch
      .items()
      .flatMap(({ agentEvent }) =>
        agentEvent === undefined ? [] : [agentEvent],
      ),
    rootEvents,
  );
  const cursor = rootEvents[1]?.sequence;
  assert.ok(cursor !== undefined);
  const replay = await watch<ThreadItem>('threads.v1.ThreadsService/Watch', {
    threadId: root.id,
    afterSequence: cursor,
  });
  const replayed = (await replay.next()).threadSnapshot;
  assert.ok(replayed !== undefined, 'the first item is the threadSnapshot');
  replay.close();
  const listedReplay = await listEvents(root.id, cursor);
  assert.deepEqual(replayed.events ?? [], listedReplay);
  assert.ok(listedReplay.length > 0);
  assert.ok(
    listedReplay.every(
      (value) =>
        value.projectId === project.id &&
        value.threadId === root.id &&
        value.sequence > cursor,
    ),
  );

  const childWatch = await watch<ThreadItem>(
    'threads.v1.ThreadsService/Watch',
    {
      threadId: child.id,
    },
  );
  assert.ok((await childWatch.next()).threadSnapshot !== undefined);
  const human = await api<{ promptId: string }>(
    'threads.v1.ThreadsService/Prompt',
    { threadId: child.id, prompt: followup },
  );
  const humanDone = finishedOf(
    await childWatch.until(
      (item) => finishedOf(item)?.promptId === human.promptId,
    ),
  );
  assert.ok(humanDone !== undefined);
  assert.equal(completion(humanDone).status, 'completed');
  assert.deepEqual(completion(humanDone).source, { kind: 'user' });
  // ready follows result-routing, so this is a barrier rather than a timing-based negative assertion.
  await childWatch.until(
    ({ threadUpdated }) =>
      threadUpdated?.state === 'ready' &&
      (threadUpdated.lastSequence ?? 0) >= humanDone.sequence,
  );
  assert.deepEqual(await listEvents(root.id), rootEvents);

  const { thread: sibling } = await api<{ thread: Thread }>(
    'projects.v1.ProjectsService/CreateThread',
    { projectId: project.id, name: 'Sibling thread' },
  );
  const siblingWatch = await watch<ThreadItem>(
    'threads.v1.ThreadsService/Watch',
    { threadId: sibling.id },
  );
  assert.ok((await siblingWatch.next()).threadSnapshot !== undefined);
  const second = await api<{ promptId: string }>(
    'threads.v1.ThreadsService/Prompt',
    { threadId: sibling.id, prompt: secondPrompt },
  );
  const secondDone = finishedOf(
    await siblingWatch.until(
      (item) => finishedOf(item)?.promptId === second.promptId,
      120_000,
    ),
  );
  assert.ok(secondDone !== undefined);
  assert.equal(completion(secondDone).status, 'completed');
  assert.equal(
    completion(secondDone).text,
    'Independent root verified the shared file.',
  );
  // One sandbox served the Project's three Threads.
  assert.equal(
    (await api<{ vms?: unknown[] }>('host.v1.HostService/ListVms')).vms?.length,
    1,
  );

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

  await api('projects.v1.ProjectsService/TerminateProject', {
    projectId: project.id,
  });
  await projectWatch.until(
    ({ projectUpdated }) => projectUpdated?.state === 'cancelled',
    120_000,
  );
  for (const thread of [root, child, sibling]) {
    assert.equal(
      (
        await api<{ thread: Thread }>('threads.v1.ThreadsService/GetThread', {
          threadId: thread.id,
        })
      ).thread.state,
      'cancelled',
    );
  }
  for (const stream of [projectWatch, rootWatch, childWatch, siblingWatch])
    stream.close();
  await api('projects.v1.ProjectsService/DeleteProject', {
    projectId: project.id,
  });
  const gone = await refusal(
    api('projects.v1.ProjectsService/GetProject', { projectId: project.id }),
  );
  assert.equal(gone.status, 404);
  assert.equal(gone.code, 'not_found');
  assert.equal(reasonOf(gone), 'project_not_found');
  for (const thread of [root, child, sibling]) {
    const missing = await refusal(
      api('threads.v1.ThreadsService/GetThread', { threadId: thread.id }),
    );
    assert.equal(missing.status, 404, thread.id);
    assert.equal(missing.code, 'not_found', thread.id);
    assert.equal(reasonOf(missing), 'thread_not_found', thread.id);
  }

  assert.equal(await host.stop(), 0);
});

void test('a request breaking a rule of a refusing RPC answers INVALID_ARGUMENT with its route reason', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const { host } = await startFixture(t);

  for (const { procedure, request, reason } of invalidRequests) {
    const error = await refusal(callApi(host.url, procedure, request));
    assert.equal(error.status, 400, procedure);
    assert.equal(error.code, 'invalid_argument', procedure);
    assert.equal(reasonOf(error), reason, procedure);
  }
  for (const { procedure, request, reason } of invalidStreams) {
    const error = await refusal(
      openStream(host.url, procedure, request).then(async (stream) => {
        try {
          return await stream.next();
        } finally {
          stream.close();
        }
      }),
    );
    assert.equal(error.code, 'invalid_argument', procedure);
    assert.equal(reasonOf(error), reason, procedure);
  }

  assert.equal(await host.stop(), 0);
});

void test("killing default's process under a running prompt brings a new default process, and the prompt finishes", {
  skip,
  timeout: 300_000,
}, async (t) => {
  const { model, host, api, listEvents, configure } = await startFixture(t);
  await configure();
  const { project } = await api<{ project: Project }>(
    'projects.v1.ProjectsService/CreateProject',
    { name: 'Respawn project' },
  );
  for (let attempt = 0; ; attempt += 1) {
    const { state, errorCode } = (
      await api<{ project: Project }>(
        'projects.v1.ProjectsService/GetProject',
        {
          projectId: project.id,
        },
      )
    ).project;
    if (state === 'ready') break;
    assert.ok(
      attempt < 900 && state !== 'failed',
      `Project ${state}${errorCode === undefined ? '' : `: ${errorCode}`}`,
    );
    await delay(200);
  }
  const { thread } = await api<{ thread: Thread }>(
    'projects.v1.ProjectsService/CreateThread',
    { projectId: project.id, name: 'Respawn thread' },
  );
  const prompt = await api<{ promptId: string }>(
    'threads.v1.ThreadsService/Prompt',
    { threadId: thread.id, prompt: heldPrompt },
  );
  await model.held;

  const hostPid = host.child.pid;
  assert.ok(hostPid !== undefined);
  const lost = await bundlePid(bundlesPath, hostPid, 'default');
  assert.ok(lost !== undefined, 'the host runs a default process');
  process.kill(lost, 'SIGKILL');

  let respawned: number | undefined;
  for (let attempt = 0; ; attempt += 1) {
    respawned = await bundlePid(bundlesPath, hostPid, 'default');
    if (respawned !== undefined && respawned !== lost) break;
    assert.ok(attempt < 300, 'no new default process came up');
    await delay(100);
  }

  let events: readonly ThreadEvent[] = [];
  for (let attempt = 0; ; attempt += 1) {
    events = (await listEvents(thread.id)).filter(
      ({ promptId }) => promptId === prompt.promptId,
    );
    if (events.some(({ type }) => type === 'prompt.finished')) break;
    assert.ok(attempt < 600, JSON.stringify(events));
    await delay(200);
  }
  const finished = events.find(({ type }) => type === 'prompt.finished');
  assert.ok(finished !== undefined);
  assert.equal(completion(finished).status, 'completed');
  assert.equal(completion(finished).text, heldAnswer);
  // The held request was lost with the process; the new one asked again.
  assert.equal(
    model.requests.filter(({ messages }) =>
      JSON.stringify(messages).includes(heldPrompt),
    ).length,
    2,
  );
  assert.deepEqual(model.failures, []);

  assert.equal(await host.stop(), 0);
});

void test('a repository created outside the Thread reaches its Watch as cwdRepo after GetGit', {
  skip,
  timeout: 300_000,
}, async (t) => {
  const { model, host, api, watch, configure } = await startFixture(t);
  await configure();
  const { project } = await api<{ project: Project }>(
    'projects.v1.ProjectsService/CreateProject',
    { name: 'Git hint project' },
  );
  for (let attempt = 0; ; attempt += 1) {
    const { state, errorCode } = (
      await api<{ project: Project }>(
        'projects.v1.ProjectsService/GetProject',
        {
          projectId: project.id,
        },
      )
    ).project;
    if (state === 'ready') break;
    assert.ok(
      attempt < 900 && state !== 'failed',
      `Project ${state}${errorCode === undefined ? '' : `: ${errorCode}`}`,
    );
    await delay(200);
  }
  const { thread } = await api<{ thread: Thread }>(
    'projects.v1.ProjectsService/CreateThread',
    { projectId: project.id, name: 'Git hint thread' },
  );
  assert.equal(thread.cwd, '/workspace');
  const threadWatch = await watch<ThreadItem>(
    'threads.v1.ThreadsService/Watch',
    { threadId: thread.id },
  );
  assert.ok((await threadWatch.next()).threadSnapshot !== undefined);

  // A first prompt settles, so the Thread's own refresh after a job has run
  // on a directory with no repository. The script answers it with text only.
  const prompt = await api<{ promptId: string }>(
    'threads.v1.ThreadsService/Prompt',
    { threadId: thread.id, prompt: followup },
  );
  await threadWatch.until(
    (item) => finishedOf(item)?.promptId === prompt.promptId,
    120_000,
  );
  assert.deepEqual(model.failures, []);

  // The repository is created outside the Thread's jobs: a manual shell runs
  // `git init`, and the shell's output proves it ran. The marker is computed,
  // so the echoed input never contains it.
  const { terminalSession } = await api<{ terminalSession: TerminalSession }>(
    'threads.v1.ThreadsService/CreateTerminal',
    { threadId: thread.id },
  );
  const terminalOutput = async () =>
    (
      await api<{
        terminalSnapshot: { terminal: TerminalSession; output?: string };
      }>('terminals.v1.TerminalsService/GetTerminal', {
        terminalId: terminalSession.id,
        after: 0,
      })
    ).terminalSnapshot;
  for (let attempt = 0; ; attempt += 1) {
    const { terminal } = await terminalOutput();
    if (terminal.state === 'running') break;
    assert.ok(
      attempt < 150 && terminal.state === 'starting',
      `terminal ${terminal.state}`,
    );
    await delay(200);
  }
  await api('terminals.v1.TerminalsService/SendInput', {
    terminalId: terminalSession.id,
    data: 'git init -q /workspace && echo T6-$((6 * 7))\n',
  });
  for (let attempt = 0; ; attempt += 1) {
    const { output = '' } = await terminalOutput();
    if (output.includes('T6-42')) break;
    assert.ok(attempt < 150, `no git init in the terminal: ${output}`);
    await delay(200);
  }

  // Nothing of the Thread's own has refreshed the hint since: only the Git
  // read below can.
  const before = await api<{ thread: Thread }>(
    'threads.v1.ThreadsService/GetThread',
    { threadId: thread.id },
  );
  assert.equal(before.thread.cwdRepo, undefined);

  const git = await api<{ status: string }>(
    'threads.v1.ThreadsService/GetGit',
    { threadId: thread.id },
  );
  assert.equal(git.status, 'ready');
  // GetGit may answer before the hint is written; the Watch opened before it
  // carries the change as a Thread update.
  const updated = (
    await threadWatch.until(
      (item) => item.threadUpdated?.cwdRepo === 'git',
      30_000,
    )
  ).threadUpdated;
  assert.equal(updated?.id, thread.id);
  assert.equal(updated?.cwd, '/workspace');

  await api('terminals.v1.TerminalsService/DeleteTerminal', {
    terminalId: terminalSession.id,
  });
  assert.equal(await host.stop(), 0);
});
