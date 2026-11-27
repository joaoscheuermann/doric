// `ProjectsService` through the router (phase 3, S60d, contract s60 §3.5, §6
// R0, R-proj-1…5, P1, P2, M1/M2): each RPC runs today's `/projects` route body
// over the routed ports and answers the route's body under its wrapper, or
// ends with the route's refusal (reason = today's code, message = today's
// message, gRPC code by §5). Lease reads answer `pending` as
// `{pending: {retryAfterSeconds: 1}}`; `ReadFile` streams `head` then the text
// in chunks of at most 1,048,576 UTF-16 code units (D7); `ListThreads` cuts a
// page under 3 MiB (D6).

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { type JsonValue, toBinary, toJson } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import {
  conflictError,
  encode,
  notFoundError,
  type RestError,
  restErrors,
} from 'runtime/contracts';
import {
  LeaseService,
  SshResponseSchema as LeaseSshResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import {
  CreateProjectResponseSchema,
  CreateThreadResponseSchema,
  DeleteProjectResponseSchema,
  GetDiffResponseSchema,
  GetFileDiffResponseSchema,
  GetProjectResourcesResponseSchema,
  GetProjectResponseSchema,
  GetProjectSshResponseSchema,
  GetTreeResponseSchema,
  ListChangesResponseSchema,
  ListFilesResponseSchema,
  ListProjectsResponseSchema,
  ListTerminalsResponseSchema,
  ListThreadsResponseSchema,
  ReadFileResponseSchema,
  SetProjectColorResponseSchema,
  TerminateProjectResponseSchema,
  UpdateProjectResponseSchema,
} from '../src/contracts/gen/doric/api/projects/v1/projects_pb.js';
import {
  assertRouteRefusal,
  assertRouteSuccess,
  internalError,
  routed,
} from './support/route-answers.js';
import { fakeOf, type Harness, harness } from './support/router.js';
import {
  type Fakes,
  leaseFailure,
  routerFakes,
} from './support/router-fakes.js';
import {
  activated,
  assertMessage,
  first,
  project,
  projectId,
  type Refusal,
  ready,
  refusalOf,
  sshAccess,
  terminal,
  thread,
  threadId,
  workspaceFakes,
} from './support/router-fixtures.js';

const refused = (reason: string, message: string, code: Code): Refusal => ({
  reason,
  message,
  code,
});

const notActive = refused(
  'unavailable',
  'transport is not active.',
  Code.Unavailable,
);
const projectMissing = refused(
  'project_not_found',
  notFoundError('project').message,
  Code.NotFound,
);

/** Every item of `stream`, in order. */
const all = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const items: T[] = [];

  for await (const item of stream) items.push(item);

  return items;
};

/** The items `stream` sent before it ended, and its refusal (`undefined` when it ended cleanly). */
const drain = async <T>(
  stream: AsyncIterable<T>,
): Promise<{ readonly items: T[]; readonly refusal: Refusal | undefined }> => {
  const items: T[] = [];

  try {
    for await (const item of stream) items.push(item);

    return { items, refusal: undefined };
  } catch (error) {
    return { items, refusal: await refusalOf(Promise.reject(error)) };
  }
};

const requestsOf = (h: Harness, method: string): JsonValue[] =>
  h.calls.filter((call) => call.method === method).map((call) => call.request);

const served = (t: TestContext, fakes: Fakes = workspaceFakes) =>
  routed(t, fakes);

/** One valid call of every `ProjectsService` method. */
const everyMethod = (
  h: Harness,
): readonly (readonly [string, () => Promise<unknown>])[] => [
  ['CreateProject', () => h.projects().createProject({ name: 'Project' })],
  ['ListProjects', () => h.projects().listProjects({})],
  ['GetProject', () => h.projects().getProject({ projectId })],
  [
    'UpdateProject',
    () => h.projects().updateProject({ projectId, name: 'Renamed' }),
  ],
  [
    'SetProjectColor',
    () => h.projects().setProjectColor({ projectId, color: 'red' }),
  ],
  [
    'CreateThread',
    () => h.projects().createThread({ projectId, name: 'Thread' }),
  ],
  ['ListThreads', () => h.projects().listThreads({ projectId })],
  ['GetProjectSsh', () => h.projects().getProjectSsh({ projectId })],
  ['ListFiles', () => h.projects().listFiles({ projectId })],
  ['GetTree', () => h.projects().getTree({ projectId })],
  ['ReadFile', () => first(h.projects().readFile({ projectId, path: 'a.ts' }))],
  ['GetDiff', () => h.projects().getDiff({ projectId })],
  ['ListChanges', () => h.projects().listChanges({ projectId })],
  [
    'GetFileDiff',
    () => h.projects().getFileDiff({ projectId, repository: '', path: 'a.ts' }),
  ],
  [
    'GetProjectResources',
    () => h.projects().getProjectResources({ projectId }),
  ],
  ['ListTerminals', () => h.projects().listTerminals({ projectId })],
  ['TerminateProject', () => h.projects().terminateProject({ projectId })],
  ['DeleteProject', () => h.projects().deleteProject({ projectId })],
  ['Watch', () => first(h.projects().watch({ projectId }))],
];

// R0 ------------------------------------------------------------------------

void test('R0: before activate every ProjectsService method answers UNAVAILABLE unavailable', async (t) => {
  const h = harness({
    fakes: (record) => routerFakes(record, workspaceFakes),
  });

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  for (const [name, call] of everyMethod(h)) {
    assert.deepEqual(await refusalOf(call()), notActive, name);
  }
  assert.deepEqual(h.calls, []);
});

void test('R0: after deactivate every ProjectsService method answers unavailable', async (t) => {
  const h = await served(t);

  await h.host.deactivate();
  for (const [name, call] of everyMethod(h)) {
    assert.deepEqual(await refusalOf(call()), notActive, name);
  }
  assert.deepEqual(h.calls, []);
});

// R-proj-1: Project CRUD ------------------------------------------------------

void test('R-proj-1: CreateProject creates the normalised name and answers {project, ssh: {href}}', async (t) => {
  const h = await served(t);
  const response = await h.projects().createProject({ name: '  New  ' });

  assertMessage(CreateProjectResponseSchema, response, {
    project: { ...project, name: 'New' },
    ssh: { href: `/projects/${projectId}/ssh` },
  });
  assert.deepEqual(requestsOf(h, 'runtime.createProject'), [{ name: 'New' }]);
});

void test('R-proj-1: ListProjects passes the page (limit 50 by default) and answers {items, nextCursor}', async (t) => {
  const cursor = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf16ff';
  const h = await served(t, {
    ...workspaceFakes,
    runtime: {
      ...workspaceFakes.runtime,
      projects: () => ({ items: [project], nextCursor: projectId }),
    },
  });

  assertMessage(
    ListProjectsResponseSchema,
    await h.projects().listProjects({}),
    { items: [project], nextCursor: projectId },
  );
  await h.projects().listProjects({ limit: 7, cursor });
  assert.deepEqual(requestsOf(h, 'runtime.projects'), [
    { limit: 50 },
    { limit: 7, cursor },
  ]);
});

void test('R-proj-1: GetProject, UpdateProject and TerminateProject answer {project}; a missing one is project_not_found', async (t) => {
  const h = await served(t);
  const other = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf16ee';

  assertMessage(
    GetProjectResponseSchema,
    await h.projects().getProject({ projectId }),
    { project },
  );
  assertMessage(
    UpdateProjectResponseSchema,
    await h.projects().updateProject({ projectId, name: ' Renamed ' }),
    { project: { ...project, name: 'Renamed' } },
  );
  assertMessage(
    TerminateProjectResponseSchema,
    await h.projects().terminateProject({ projectId }),
    { project: { ...project, state: 'cancelled' } },
  );
  assert.deepEqual(
    await refusalOf(h.projects().getProject({ projectId: other })),
    projectMissing,
  );
  assert.deepEqual(
    await refusalOf(
      h.projects().updateProject({ projectId: other, name: 'Renamed' }),
    ),
    projectMissing,
  );
  assert.deepEqual(requestsOf(h, 'runtime.renameProject')[0], {
    id: projectId,
    name: 'Renamed',
  });
});

void test('R-proj-1: SetProjectColor sets a palette colour, and without color clears it (color null)', async (t) => {
  const received: unknown[] = [];
  const h = await served(t, {
    ...workspaceFakes,
    runtime: {
      ...workspaceFakes.runtime,
      setProjectColor: (input: { id: string; color: string | null }) => {
        received.push(input);
        return input.color === null
          ? project
          : { ...project, color: input.color };
      },
    },
  });

  assertMessage(
    SetProjectColorResponseSchema,
    await h.projects().setProjectColor({ projectId, color: 'red' }),
    { project: { ...project, color: 'red' } },
  );
  assertMessage(
    SetProjectColorResponseSchema,
    await h.projects().setProjectColor({ projectId }),
    { project },
  );
  assert.deepEqual(received, [
    { id: projectId, color: 'red' },
    { id: projectId, color: null },
  ]);
  assert.deepEqual(requestsOf(h, 'runtime.setProjectColor'), [
    { id: projectId, color: 'red' },
    { id: projectId },
  ]);
});

void test('R-proj-1: DeleteProject answers {} when deleted, project_active and project_not_found as the route does', async (t) => {
  for (const [result, expected] of [
    ['deleted', undefined],
    [
      'active',
      refused(
        'project_active',
        conflictError('project', 'active').message,
        Code.FailedPrecondition,
      ),
    ],
    ['missing', projectMissing],
  ] as const) {
    const h = await served(t, {
      ...workspaceFakes,
      runtime: { ...workspaceFakes.runtime, deleteProject: () => result },
    });
    const call = h.projects().deleteProject({ projectId });

    if (expected === undefined) {
      assertMessage(DeleteProjectResponseSchema, await call, {});
    } else {
      assert.deepEqual(await refusalOf(call), expected, result);
    }
  }
});

void test('R-proj-1: CreateThread creates the Thread under the Project with its parent and answers {thread}', async (t) => {
  const parentThreadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf16dd';
  const h = await served(t);

  assertMessage(
    CreateThreadResponseSchema,
    await h
      .projects()
      .createThread({ projectId, name: ' Child ', parentThreadId }),
    { thread: { ...thread, name: 'Child' } },
  );
  assert.deepEqual(requestsOf(h, 'threads.createThread'), [
    { projectId, name: 'Child', parentThreadId },
  ]);
});

void test('R-proj-1: ListTerminals answers {items} from terminal/v1.List', async (t) => {
  const h = await served(t);
  const response = await h.projects().listTerminals({ projectId });

  assert.equal(response.items.length, 1);
  assert.deepEqual(
    toJson(ListTerminalsResponseSchema, response),
    toJson(
      ListTerminalsResponseSchema,
      encode(ListTerminalsResponseSchema, {
        items: workspaceFakes.terminal.list(),
      }),
    ),
  );
  assert.deepEqual(requestsOf(h, 'terminal.list'), [{ projectId }]);
});

// R-proj-2: workspace reads -----------------------------------------------------

const pending = { pending: { retryAfterSeconds: 1 } };

/** The unary workspace reads: the fake service and method each reads, and its call. */
const reads = [
  {
    rpc: 'ListFiles',
    fake: 'files',
    method: 'directory',
    schema: ListFilesResponseSchema,
    call: (h: Harness) => h.projects().listFiles({ projectId, path: 'src' }),
  },
  {
    rpc: 'GetTree',
    fake: 'files',
    method: 'tree',
    schema: GetTreeResponseSchema,
    call: (h: Harness) => h.projects().getTree({ projectId }),
  },
  {
    rpc: 'GetDiff',
    fake: 'git',
    method: 'diff',
    schema: GetDiffResponseSchema,
    call: (h: Harness) => h.projects().getDiff({ projectId, path: 'src' }),
  },
  {
    rpc: 'ListChanges',
    fake: 'git',
    method: 'changes',
    schema: ListChangesResponseSchema,
    call: (h: Harness) => h.projects().listChanges({ projectId }),
  },
  {
    rpc: 'GetFileDiff',
    fake: 'git',
    method: 'fileDiff',
    schema: GetFileDiffResponseSchema,
    call: (h: Harness) =>
      h.projects().getFileDiff({ projectId, repository: '', path: 'a.ts' }),
  },
  {
    rpc: 'GetProjectResources',
    fake: 'resources',
    method: 'project',
    schema: GetProjectResourcesResponseSchema,
    call: (h: Harness) => h.projects().getProjectResources({ projectId }),
  },
] as const;

/** `workspaceFakes` with `fake.method` answering `value`. */
const answering = (fake: string, method: string, value: unknown): Fakes => {
  const base = workspaceFakes as unknown as Record<
    string,
    Record<string, unknown>
  >;

  return {
    ...workspaceFakes,
    [fake]: { ...base[fake], [method]: () => value },
  } as Fakes;
};

void test('R-proj-2: a pending lease answers {pending: {retryAfterSeconds: 1}} on every workspace read', async (t) => {
  for (const read of reads) {
    const h = await served(
      t,
      answering(read.fake, read.method, {
        status: 'pending',
      }),
    );

    assertMessage(read.schema, await read.call(h), pending, read.rpc);
  }

  const h = await served(
    t,
    answering('files', 'content', {
      status: 'pending',
    }),
  );
  const items = await all(h.projects().readFile({ projectId, path: 'a.ts' }));

  assert.deepEqual(
    items.map((item) => toJson(ReadFileResponseSchema, item)),
    [pending],
  );
});

void test('R-proj-2: missing, expired and unavailable leases answer the route refusals on every workspace read', async (t) => {
  const leaseRefusals: readonly (readonly [string, RestError])[] = [
    ['missing', notFoundError('project')],
    [
      'expired',
      {
        status: 410,
        code: 'project_files_expired',
        message: 'The Project file access has expired.',
      },
    ],
    ['unavailable', conflictError('project', 'files_unavailable')],
  ];

  for (const [status, expected] of leaseRefusals) {
    for (const read of reads) {
      const fakes = answering(read.fake, read.method, { status });

      await assertRouteRefusal(
        t,
        fakes,
        expected,
        read.call,
        `${read.rpc} ${status}`,
      );
    }
  }
});

/** Today's path refusals of the workspace reads. */
const pathNotFound = (message: string): RestError => ({
  status: 404,
  code: 'project_path_not_found',
  message,
});
const invalidPath = (message: string): RestError => ({
  status: 422,
  code: 'invalid_project_path',
  message,
});

void test("R-proj-2: each read status answers the route's reason and message", async (t) => {
  const notFound = pathNotFound('The Project path was not found.');
  const notDirectory = invalidPath('The Project path is not a directory.');
  const cases = [
    ['ListFiles', 'files', 'directory', 'not_found', notFound],
    ['ListFiles', 'files', 'directory', 'not_directory', notDirectory],
    ['ListFiles', 'files', 'directory', 'invalid_path', notDirectory],
    ['GetTree', 'files', 'tree', 'not_found', notFound],
    ['GetTree', 'files', 'tree', 'not_directory', notDirectory],
    ['GetDiff', 'git', 'diff', 'not_found', notFound],
    [
      'GetDiff',
      'git',
      'diff',
      'invalid_path',
      invalidPath('The Project path is invalid.'),
    ],
    [
      'ListChanges',
      'git',
      'changes',
      'not_found',
      pathNotFound('The Project path cannot be read.'),
    ],
    [
      'ListChanges',
      'git',
      'changes',
      'invalid_path',
      invalidPath('The Project path cannot be read.'),
    ],
    [
      'GetFileDiff',
      'git',
      'fileDiff',
      'not_found',
      pathNotFound('The changed file cannot be read.'),
    ],
    [
      'GetFileDiff',
      'git',
      'fileDiff',
      'invalid_path',
      invalidPath('The changed file cannot be read.'),
    ],
  ] as const;

  for (const [rpc, fake, method, status, expected] of cases) {
    const read = reads.find((entry) => entry.rpc === rpc);

    assert.ok(read !== undefined);
    await assertRouteRefusal(
      t,
      answering(fake, method, ready({ status })),
      expected,
      read.call,
      `${rpc} ${status}`,
    );
  }
});

void test('R-proj-2: the files, git and resources reads carry the scope {projectId}', async (t) => {
  const h = await served(t);

  for (const read of reads) await read.call(h);
  await all(h.projects().readFile({ projectId, path: 'a.ts' }));

  const scoped = h.calls.filter(({ method }) =>
    /^(files|git|resources)\./.test(method),
  );

  assert.deepEqual(scoped.map(({ method }) => method).sort(), [
    'files.content',
    'files.directory',
    'files.tree',
    'git.changes',
    'git.diff',
    'git.fileDiff',
    'resources.project',
  ]);
  for (const call of scoped) {
    assert.equal(call.scope?.projectId, projectId, call.method);
  }
  assert.deepEqual(requestsOf(h, 'files.directory'), [{ path: 'src' }]);
  assert.deepEqual(requestsOf(h, 'git.fileDiff'), [{ path: 'a.ts' }]);
});

// R-proj-3: GetProjectSsh --------------------------------------------------------

/** A `runtime.lease/v1` fake: `Describe` fails with `describeFailure` when given, `Ssh` answers `access`. */
const leaseFakes = (
  t: TestContext,
  describeFailure: string | undefined,
  access: unknown,
) =>
  activated(t, {
    fakes: (record) => [
      ...routerFakes(record, {}),
      fakeOf(LeaseService, {
        describe: (_request, context) => {
          record('lease.describe', {}, context);
          if (describeFailure !== undefined) {
            throw leaseFailure(describeFailure);
          }

          return { id: 'sandbox-1', root: '/workspace' };
        },
        ssh: (request, context) => {
          record(
            'lease.ssh',
            { expectSandboxId: request.target?.expectSandboxId ?? '' },
            context,
          );

          return access === undefined
            ? { vmId: 'vm-1' }
            : encode(LeaseSshResponseSchema, {
                vmId: 'vm-1',
                response: access,
              });
        },
      }),
    ],
  });

void test('R-proj-3: GetProjectSsh answers the ready access with its href, scoped to the Project', async (t) => {
  const h = await leaseFakes(t, undefined, sshAccess);

  assertMessage(
    GetProjectSshResponseSchema,
    await h.projects().getProjectSsh({ projectId }),
    { value: { vmId: 'vm-1', ssh: sshAccess, href: '/vms/vm-1/ssh' } },
  );
  assert.deepEqual(
    h.calls.map(({ method }) => method),
    ['lease.describe', 'lease.ssh'],
  );
  for (const call of h.calls) assert.equal(call.scope?.projectId, projectId);
  assert.deepEqual(requestsOf(h, 'lease.ssh'), [
    { expectSandboxId: 'sandbox-1' },
  ]);
});

void test('R-proj-3: Describe failing with each leaseStatus, and Ssh without access, answer the route refusals', async (t) => {
  const cases = [
    ['missing', undefined, projectMissing],
    ['pending', undefined, undefined],
    [
      'expired',
      undefined,
      refused(
        'project_ssh_expired',
        'SSH access has expired.',
        Code.FailedPrecondition,
      ),
    ],
    [
      'unavailable',
      undefined,
      refused(
        'project_ssh_unavailable',
        conflictError('project', 'ssh_unavailable').message,
        Code.FailedPrecondition,
      ),
    ],
    [
      undefined,
      'no access',
      refused(
        'project_ssh_unavailable',
        conflictError('project', 'ssh_unavailable').message,
        Code.FailedPrecondition,
      ),
    ],
  ] as const;

  for (const [failure, label, expected] of cases) {
    const h = await leaseFakes(t, failure, undefined);
    const call = h.projects().getProjectSsh({ projectId });

    if (expected === undefined) {
      assertMessage(GetProjectSshResponseSchema, await call, pending);
    } else {
      assert.deepEqual(await refusalOf(call), expected, failure ?? label);
    }
  }
});

// R-proj-4: ReadFile ---------------------------------------------------------------

const content = (text: string) =>
  answering(
    'files',
    'content',
    ready({
      status: 'read',
      path: 'a.ts',
      content: text,
      truncated: false,
      binary: false,
    }),
  );

const head = {
  head: { status: 'read', path: 'a.ts', truncated: false, binary: false },
};

void test('R-proj-4: ReadFile streams head then the text as one content item', async (t) => {
  const h = await served(t, content('hello'));
  const items = await all(h.projects().readFile({ projectId, path: 'a.ts' }));

  assert.deepEqual(
    items.map((item) => toJson(ReadFileResponseSchema, item)),
    [head, { content: 'hello' }].map((item) =>
      toJson(ReadFileResponseSchema, encode(ReadFileResponseSchema, item)),
    ),
  );
  assert.deepEqual(requestsOf(h, 'files.content'), [{ path: 'a.ts' }]);
});

void test('R-proj-4: ReadFile of an empty text streams the head only', async (t) => {
  const h = await served(t, content(''));
  const items = await all(h.projects().readFile({ projectId, path: 'a.ts' }));

  assert.deepEqual(
    items.map((item) => toJson(ReadFileResponseSchema, item)),
    [toJson(ReadFileResponseSchema, encode(ReadFileResponseSchema, head))],
  );
});

void test('R-proj-4: a text over 1 MiB is split into chunks of at most 1,048,576 code units, never inside a code point', async (t) => {
  const limit = 1_048_576;
  const text = `${'a'.repeat(limit - 1)}😀${'b'.repeat(10)}`;
  const h = await served(t, content(text));
  const items = await all(h.projects().readFile({ projectId, path: 'a.ts' }));
  const [first, ...rest] = items;

  assert.equal(first?.item.case, 'head');
  const chunks = rest.map(({ item }) => {
    assert.equal(item.case, 'content');

    return item.value as string;
  });

  assert.equal(chunks.join(''), text);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= limit, `${chunk.length}`);
    assert.doesNotMatch(
      chunk,
      /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/,
      'a chunk splits a code point',
    );
  }
});

void test('R-proj-4: not_found and not_file end ReadFile with the route refusal before any item', async (t) => {
  for (const [status, expected] of [
    ['not_found', pathNotFound('The Project path was not found.')],
    ['not_file', invalidPath('The Project path is not a readable file.')],
  ] as const) {
    const fakes = answering('files', 'content', ready({ status }));
    await assertRouteRefusal(
      t,
      fakes,
      expected,
      (h) => all(h.projects().readFile({ projectId, path: 'a.ts' })),
      `ReadFile ${status}`,
    );

    const h = await served(t, fakes);
    const { items, refusal } = await drain(
      h.projects().readFile({ projectId, path: 'a.ts' }),
    );

    assert.deepEqual(items, [], status);
    assert.ok(refusal !== undefined, status);
  }
});

// R-proj-5: ListThreads cut under 3 MiB -------------------------------------------

const MAX = 3 * 1024 * 1024;

/** `count` Threads of about 64 KiB each, with distinct ids. */
const bigThreads = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    ...thread,
    id: `018f47d2-e3b1-7b4f-8b2c-${index.toString(16).padStart(12, '0')}`,
    cwd: `/${'w'.repeat(64 * 1024)}`,
  }));

const pageSize = (items: readonly unknown[], nextCursor?: string) =>
  toBinary(
    ListThreadsResponseSchema,
    encode(ListThreadsResponseSchema, {
      threadPage: {
        items,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    }),
  ).length;

void test('R-proj-5: ListThreads keeps the longest prefix under 3 MiB and sets nextCursor to its last id', async (t) => {
  const items = bigThreads(56);

  assert.ok(pageSize(items) > MAX, 'the page is over 3 MiB');
  const h = await served(t, {
    ...workspaceFakes,
    threads: { ...workspaceFakes.threads, threads: () => ({ items }) },
  });
  const { threadPage } = await h.projects().listThreads({ projectId });
  const kept = threadPage?.items.length ?? 0;

  assert.ok(kept >= 1 && kept < items.length, `${kept}`);
  assert.deepEqual(
    threadPage?.items.map(({ id }) => id),
    items.slice(0, kept).map(({ id }) => id),
  );
  assert.equal(threadPage?.nextCursor, items[kept - 1]?.id);
  assert.ok(pageSize(items.slice(0, kept), items[kept - 1]?.id) < MAX);
  assert.ok(
    pageSize(items.slice(0, kept + 1), items[kept]?.id) >= MAX,
    'one more item would fit',
  );
});

void test('R-proj-5: an uncut ListThreads page gets no nextCursor added; the runtime one is kept', async (t) => {
  for (const nextCursor of [undefined, threadId]) {
    const h = await served(t, {
      ...workspaceFakes,
      threads: {
        ...workspaceFakes.threads,
        threads: () => ({
          items: [thread],
          ...(nextCursor === undefined ? {} : { nextCursor }),
        }),
      },
    });

    assertMessage(
      ListThreadsResponseSchema,
      await h.projects().listThreads({ projectId, limit: 1 }),
      {
        threadPage: {
          items: [thread],
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
      },
    );
    assert.deepEqual(requestsOf(h, 'threads.threads'), [
      { projectId, limit: 1 },
    ]);
  }
});

// P1 / P2 ---------------------------------------------------------------------------

void test("P1: each runtime outcome of the Project routes ends the RPC with the route's reason, message and §5 code", async (t) => {
  const missing = (member: string): Fakes => ({
    ...workspaceFakes,
    runtime: { ...workspaceFakes.runtime, [member]: () => undefined },
  });
  const cases: readonly (readonly [
    string,
    Fakes,
    RestError | undefined,
    (h: Harness) => Promise<unknown>,
  ])[] = [
    [
      'project undefined',
      missing('project'),
      restErrors.project(undefined),
      (h) => h.projects().getProject({ projectId }),
    ],
    [
      'renameProject undefined',
      missing('renameProject'),
      restErrors.project(undefined),
      (h) => h.projects().updateProject({ projectId, name: 'Name' }),
    ],
    [
      'setProjectColor undefined',
      missing('setProjectColor'),
      restErrors.project(undefined),
      (h) => h.projects().setProjectColor({ projectId }),
    ],
    [
      'terminateProject undefined',
      missing('terminateProject'),
      restErrors.project(undefined),
      (h) => h.projects().terminateProject({ projectId }),
    ],
    ...(['missing', 'active'] as const).map(
      (result) =>
        [
          `deleteProject ${result}`,
          {
            ...workspaceFakes,
            runtime: { ...workspaceFakes.runtime, deleteProject: () => result },
          },
          restErrors.deleteProject(result),
          (h: Harness) => h.projects().deleteProject({ projectId }),
        ] as const,
    ),
    ...(['missing', 'inactive', 'invalid_parent'] as const).map(
      (status) =>
        [
          `createThread ${status}`,
          {
            ...workspaceFakes,
            threads: {
              ...workspaceFakes.threads,
              createThread: () => ({ status }),
            },
          },
          restErrors.createThread({ status }),
          (h: Harness) =>
            h.projects().createThread({ projectId, name: 'Thread' }),
        ] as const,
    ),
    [
      'threads undefined',
      {
        ...workspaceFakes,
        threads: { ...workspaceFakes.threads, threads: () => undefined },
      },
      restErrors.threads(undefined),
      (h) => h.projects().listThreads({ projectId }),
    ],
    [
      'unexpected failure',
      {
        ...workspaceFakes,
        runtime: {
          ...workspaceFakes.runtime,
          project: () => {
            throw new Error('secret provider credentials');
          },
        },
      },
      internalError,
      (h) => h.projects().getProject({ projectId }),
    ],
  ];

  for (const [name, fakes, expected, call] of cases) {
    await assertRouteRefusal(t, fakes, expected, call, name);
  }
});

void test("P2: one success per ProjectsService RPC answers the route's body under its wrapper", async (t) => {
  const asIs = (body: unknown) => body;
  const value = (body: unknown) => ({ value: body });
  // Today's route bodies over `workspaceFakes`.
  const cases = [
    [
      'CreateProject',
      { ...project, ssh: { href: `/projects/${projectId}/ssh` } },
      CreateProjectResponseSchema,
      (h: Harness) => h.projects().createProject({ name: 'Project' }),
      (body: unknown) => {
        const { ssh, ...rest } = body as { ssh: unknown };

        return { project: rest, ssh };
      },
    ],
    [
      'ListProjects',
      { items: [project] },
      ListProjectsResponseSchema,
      (h: Harness) => h.projects().listProjects({}),
      asIs,
    ],
    [
      'GetProject',
      project,
      GetProjectResponseSchema,
      (h: Harness) => h.projects().getProject({ projectId }),
      (body: unknown) => ({ project: body }),
    ],
    [
      'UpdateProject',
      { ...project, name: 'Renamed' },
      UpdateProjectResponseSchema,
      (h: Harness) =>
        h.projects().updateProject({ projectId, name: 'Renamed' }),
      (body: unknown) => ({ project: body }),
    ],
    [
      'SetProjectColor',
      { ...project, color: 'red' },
      SetProjectColorResponseSchema,
      (h: Harness) => h.projects().setProjectColor({ projectId, color: 'red' }),
      (body: unknown) => ({ project: body }),
    ],
    [
      'CreateThread',
      thread,
      CreateThreadResponseSchema,
      (h: Harness) => h.projects().createThread({ projectId, name: 'Thread' }),
      (body: unknown) => ({ thread: body }),
    ],
    [
      'ListThreads',
      { items: [thread] },
      ListThreadsResponseSchema,
      (h: Harness) => h.projects().listThreads({ projectId }),
      (body: unknown) => ({ threadPage: body }),
    ],
    [
      'GetProjectSsh',
      { status: 'ready', vmId: 'vm-1', ssh: sshAccess, href: '/vms/vm-1/ssh' },
      GetProjectSshResponseSchema,
      (h: Harness) => h.projects().getProjectSsh({ projectId }),
      value,
    ],
    [
      'ListFiles',
      {
        path: 'src',
        entries: [{ name: 'a.ts', path: 'src/a.ts', type: 'file' }],
      },
      ListFilesResponseSchema,
      (h: Harness) => h.projects().listFiles({ projectId, path: 'src' }),
      value,
    ],
    [
      'GetTree',
      { path: '', entries: [] },
      GetTreeResponseSchema,
      (h: Harness) => h.projects().getTree({ projectId }),
      value,
    ],
    [
      'GetDiff',
      { path: 'src', repositories: [] },
      GetDiffResponseSchema,
      (h: Harness) => h.projects().getDiff({ projectId, path: 'src' }),
      value,
    ],
    [
      'ListChanges',
      { repositories: [] },
      ListChangesResponseSchema,
      (h: Harness) => h.projects().listChanges({ projectId }),
      value,
    ],
    [
      'GetFileDiff',
      {
        path: 'a.ts',
        status: 'modified',
        staged: false,
        unstaged: true,
        indexStatus: ' ',
        worktreeStatus: 'M',
        repository: '',
        original: 'a',
        modified: 'b',
        binary: false,
        truncated: false,
      },
      GetFileDiffResponseSchema,
      (h: Harness) =>
        h.projects().getFileDiff({ projectId, repository: '', path: 'a.ts' }),
      value,
    ],
    [
      'GetProjectResources',
      {
        status: 'ready',
        at: '2026-01-01T00:00:00.000Z',
        cpuCount: 2,
        memoryUsedBytes: 1024,
      },
      GetProjectResourcesResponseSchema,
      (h: Harness) => h.projects().getProjectResources({ projectId }),
      value,
    ],
    [
      'ListTerminals',
      { items: [terminal] },
      ListTerminalsResponseSchema,
      (h: Harness) => h.projects().listTerminals({ projectId }),
      asIs,
    ],
    [
      'TerminateProject',
      { ...project, state: 'cancelled' },
      TerminateProjectResponseSchema,
      (h: Harness) => h.projects().terminateProject({ projectId }),
      (body: unknown) => ({ project: body }),
    ],
    [
      'DeleteProject',
      undefined,
      DeleteProjectResponseSchema,
      (h: Harness) => h.projects().deleteProject({ projectId }),
      () => ({}),
    ],
  ] as const;

  for (const [rpc, body, schema, call, wrap] of cases) {
    await assertRouteSuccess(
      t,
      workspaceFakes,
      body,
      schema,
      call as never,
      wrap,
      rpc,
    );
  }
});

void test("P2: ReadFile streams the route's {path, content, truncated, binary} as head and content", async (t) => {
  // Today's `GET /projects/:id/files/content?path=a.ts` body over `workspaceFakes`.
  const { content: text, ...rest } = {
    path: 'a.ts',
    content: 'hello',
    truncated: false,
    binary: false,
  };
  const h = await served(t);
  const items = await all(h.projects().readFile({ projectId, path: 'a.ts' }));

  assert.deepEqual(
    items.map((item) => toJson(ReadFileResponseSchema, item)),
    [{ head: { status: 'read', ...rest } }, { content: text }].map((item) =>
      toJson(ReadFileResponseSchema, encode(ReadFileResponseSchema, item)),
    ),
  );
});

// M1 / M2 in process ------------------------------------------------------------------

void test('M1: a request breaking a rule of each field answers INVALID_ARGUMENT with the table reason, before any call', async (t) => {
  const h = await served(t);
  const bad = 'not-an-id';
  const id = refused(
    'invalid_project_id',
    'The project ID is invalid.',
    Code.InvalidArgument,
  );
  const name = refused(
    'invalid_project',
    'A Project name between 1 and 80 characters is required.',
    Code.InvalidArgument,
  );
  const page = refused(
    'invalid_page',
    'The page is invalid.',
    Code.InvalidArgument,
  );
  const path = refused(
    'invalid_project_path',
    'The Project path is invalid.',
    Code.InvalidArgument,
  );
  const nul = 'a\u0000b';
  const cases: readonly (readonly [string, () => Promise<unknown>, Refusal])[] =
    [
      [
        'CreateProject name',
        () => h.projects().createProject({ name: '' }),
        name,
      ],
      [
        'ListProjects limit',
        () => h.projects().listProjects({ limit: 0 }),
        page,
      ],
      [
        'ListProjects cursor',
        () => h.projects().listProjects({ cursor: bad }),
        page,
      ],
      ['GetProject id', () => h.projects().getProject({ projectId: bad }), id],
      [
        'UpdateProject id',
        () => h.projects().updateProject({ projectId: bad, name: 'x' }),
        id,
      ],
      [
        'UpdateProject name',
        () => h.projects().updateProject({ projectId, name: ' ' }),
        name,
      ],
      [
        'SetProjectColor color',
        () => h.projects().setProjectColor({ projectId, color: 'purple' }),
        refused(
          'invalid_project_color',
          'A Project color from the palette, or null, is required.',
          Code.InvalidArgument,
        ),
      ],
      [
        'CreateThread parent',
        () =>
          h
            .projects()
            .createThread({ projectId, name: 'x', parentThreadId: bad }),
        refused(
          'invalid_thread',
          'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
          Code.InvalidArgument,
        ),
      ],
      [
        'ListThreads limit',
        () => h.projects().listThreads({ projectId, limit: 101 }),
        page,
      ],
      [
        'ListFiles path',
        () => h.projects().listFiles({ projectId, path: nul }),
        path,
      ],
      [
        'GetTree path',
        () => h.projects().getTree({ projectId, path: 'x'.repeat(4097) }),
        path,
      ],
      [
        'ReadFile path',
        () => first(h.projects().readFile({ projectId, path: nul })),
        path,
      ],
      [
        'GetDiff path',
        () => h.projects().getDiff({ projectId, path: nul }),
        path,
      ],
      [
        'ListChanges path',
        () => h.projects().listChanges({ projectId, path: nul }),
        path,
      ],
      [
        'GetFileDiff empty path',
        () => h.projects().getFileDiff({ projectId, repository: '', path: '' }),
        path,
      ],
      [
        'GetProjectSsh id',
        () => h.projects().getProjectSsh({ projectId: bad }),
        id,
      ],
      [
        'GetProjectResources id',
        () => h.projects().getProjectResources({ projectId: bad }),
        id,
      ],
      [
        'TerminateProject id',
        () => h.projects().terminateProject({ projectId: bad }),
        id,
      ],
      [
        'DeleteProject id',
        () => h.projects().deleteProject({ projectId: bad }),
        id,
      ],
    ];

  for (const [label, call, expected] of cases) {
    assert.deepEqual(await refusalOf(call()), expected, label);
  }
  assert.deepEqual(h.calls, []);
});

void test('M2: a Project request breaking the path field and a body rule answers the path reason', async (t) => {
  const h = await served(t);

  assert.deepEqual(
    await refusalOf(
      h.projects().updateProject({ projectId: 'not-an-id', name: '' }),
    ),
    refused(
      'invalid_project_id',
      'The project ID is invalid.',
      Code.InvalidArgument,
    ),
  );
});
