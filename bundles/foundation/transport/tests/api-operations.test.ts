import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import type { ApiAnswer, RouteInput } from '../src/host/api/answer.js';
import { configOperations } from '../src/host/api/operations/config.js';
import { credentialOperations } from '../src/host/api/operations/credentials.js';
import { projectOperations } from '../src/host/api/operations/projects.js';
import { terminalOperations } from '../src/host/api/operations/terminals.js';
import { threadOperations } from '../src/host/api/operations/threads.js';
import type { TransportPorts } from '../src/host/api/ports.js';

/*
 * S60b K2 (contract s60 §2.6, §3): each route body, moved into an operation
 * over `TransportPorts`, answers what its route answers today — `pending` for
 * a pending lease state, `ok` with today's success status, a refusal with
 * today's status, code and message — and never throws a refusal. The ports are
 * faked at the consumed-contract boundary; each fake answers only what the
 * case needs.
 */

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';
const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';
const terminalId = 'terminal-1';

type ProjectPorts = Pick<
  TransportPorts,
  'runtime' | 'threads' | 'lease' | 'files' | 'git' | 'resources'
>;
type ThreadPorts = Pick<TransportPorts, 'threads' | 'git' | 'usage'>;

/** The fakes a case gives, typed as the ports the operation takes. */
const ports = <P>(fakes: object): P => fakes as unknown as P;

const input = (
  params: Readonly<Record<string, string>>,
  body?: unknown,
  query: unknown = {},
): RouteInput => ({ params, query, body });

const refused = (
  status: number,
  code: string,
  message: string,
): ApiAnswer<never> => ({ kind: 'refused', error: { status, code, message } });

/** Today's `missing(response, 'project')` and `conflict(...)` sentences. */
const projectNotFound = refused(
  404,
  'project_not_found',
  'The project was not found.',
);

/** Every Project read that answers the lease state, with the query its route reads. */
const leaseReads = [
  { name: 'files', query: {} },
  { name: 'tree', query: {} },
  { name: 'content', query: { path: 'README.md' } },
  { name: 'diff', query: {} },
  { name: 'changes', query: {} },
  { name: 'fileDiff', query: { repository: '', path: 'README.md' } },
  { name: 'resources', query: {} },
] as const;

/** Ports whose every lease-bound Project read answers `status`, recording the scope it was bound to. */
const leaseState = (status: string, scopes: unknown[]) => {
  const outcome = async () => ({ status });
  const bound =
    <T>(service: T) =>
    (scope?: unknown) => {
      scopes.push(scope);
      return service;
    };
  return ports<ProjectPorts>({
    files: bound({ directory: outcome, tree: outcome, content: outcome }),
    git: bound({ diff: outcome, changes: outcome, fileDiff: outcome }),
    resources: bound({ project: outcome }),
  });
};

test('K2: every Project lease read answers pending (not a refusal) for a pending lease, bound to the Project', async () => {
  for (const read of leaseReads) {
    const scopes: unknown[] = [];
    const operations = projectOperations(leaseState('pending', scopes));
    const answer = await operations[read.name](
      input({ id: projectId }, undefined, read.query),
    );
    assert.deepEqual(answer, { kind: 'pending' }, read.name);
    assert.deepEqual(scopes, [{ projectId }], read.name);
  }
});

test("K2: every Project lease read refuses missing, expired and unavailable with today's answers", async () => {
  const expected = {
    missing: projectNotFound,
    expired: refused(
      410,
      'project_files_expired',
      'The Project file access has expired.',
    ),
    unavailable: refused(
      409,
      'project_files_unavailable',
      'The project cannot perform this operation.',
    ),
  } as const;
  for (const read of leaseReads) {
    for (const [status, answer] of Object.entries(expected)) {
      const operations = projectOperations(leaseState(status, []));
      assert.deepEqual(
        await operations[read.name](
          input({ id: projectId }, undefined, read.query),
        ),
        answer,
        `${read.name} ${status}`,
      );
    }
  }
});

test('K2: a ready directory read answers 200 with its path and entries', async () => {
  const entries = [{ name: 'src', kind: 'directory' }];
  const operations = projectOperations(
    ports<ProjectPorts>({
      files: () => ({
        directory: async () => ({
          status: 'ready',
          value: { status: 'listed', path: 'app', entries },
        }),
      }),
    }),
  );
  assert.deepEqual(
    await operations.files(
      input({ id: projectId }, undefined, { path: 'app' }),
    ),
    { kind: 'ok', status: 200, value: { path: 'app', entries } },
  );
});

test('K2: GetProjectSsh answers pending for a pending lease and the ready access with its href', async () => {
  const scopes: unknown[] = [];
  const lease = (answer: unknown) =>
    ports<ProjectPorts>({
      lease: (scope: unknown) => {
        scopes.push(scope);
        return { ssh: async () => answer };
      },
    });

  assert.deepEqual(
    await projectOperations(lease({ status: 'pending' })).ssh(
      input({ id: projectId }),
    ),
    { kind: 'pending' },
  );
  assert.deepEqual(scopes, [{ projectId }]);

  const ready = {
    status: 'ready',
    vmId: 'vm 1',
    ssh: { host: '127.0.0.1', port: 2222, user: 'doric' },
  };
  assert.deepEqual(
    await projectOperations(lease(ready)).ssh(input({ id: projectId })),
    {
      kind: 'ok',
      status: 200,
      value: { ...ready, href: '/vms/vm%201/ssh' },
    },
  );
  assert.deepEqual(
    await projectOperations(lease({ status: 'expired' })).ssh(
      input({ id: projectId }),
    ),
    refused(410, 'project_ssh_expired', 'SSH access has expired.'),
  );
});

test('K2: CreateProject answers 202 with the Project and its SSH href', async () => {
  const project = { id: projectId, name: 'Plan' };
  const calls: unknown[] = [];
  const operations = projectOperations(
    ports<ProjectPorts>({
      runtime: {
        createProject: async (request: unknown) => {
          calls.push(request);
          return project;
        },
      },
    }),
  );
  assert.deepEqual(await operations.create(input({}, { name: '  Plan  ' })), {
    kind: 'ok',
    status: 202,
    value: { ...project, ssh: { href: `/projects/${projectId}/ssh` } },
  });
  assert.deepEqual(calls, [{ name: 'Plan' }]);
});

test("K2: CreateProject refuses an invalid body with today's 422", async () => {
  const operations = projectOperations(ports<ProjectPorts>({}));
  assert.deepEqual(
    await operations.create(input({}, { name: 'Plan', extra: true })),
    refused(
      422,
      'invalid_project',
      'A Project name between 1 and 80 characters is required.',
    ),
  );
});

test('K2: CreateThread answers 201 with the Thread', async () => {
  const thread = { id: threadId, projectId, name: 'Plan' };
  const operations = projectOperations(
    ports<ProjectPorts>({
      threads: { createThread: async () => ({ status: 'created', thread }) },
    }),
  );
  assert.deepEqual(
    await operations.createThread(input({ id: projectId }, { name: 'Plan' })),
    { kind: 'ok', status: 201, value: thread },
  );
});

test('K2: DeleteProject answers 204, and refuses missing and active', async () => {
  const remove = (result: string) =>
    projectOperations(
      ports<ProjectPorts>({ runtime: { deleteProject: async () => result } }),
    ).remove(input({ id: projectId }));

  assert.deepEqual(await remove('deleted'), {
    kind: 'ok',
    status: 204,
    value: undefined,
  });
  assert.deepEqual(await remove('missing'), projectNotFound);
  assert.deepEqual(
    await remove('active'),
    refused(
      409,
      'project_active',
      'The project cannot perform this operation.',
    ),
  );
});

test('D1: an operation checks no path UUID', async () => {
  const seen: unknown[] = [];
  const operations = projectOperations(
    ports<ProjectPorts>({
      runtime: {
        project: async (id: unknown) => {
          seen.push(id);
          return undefined;
        },
      },
    }),
  );
  assert.deepEqual(
    await operations.get(input({ id: 'not-a-uuid' })),
    projectNotFound,
  );
  assert.deepEqual(seen, ['not-a-uuid']);
});

test('an unexpected failure rejects the operation instead of answering', async () => {
  const failure = new Error('runtime is down');
  const operations = projectOperations(
    ports<ProjectPorts>({
      runtime: {
        project: async () => {
          throw failure;
        },
      },
    }),
  );
  await assert.rejects(operations.get(input({ id: projectId })), failure);
});

test('K2: Prompt, Resume and Rewind answer 202', async () => {
  const thread = { id: threadId, projectId, name: 'Plan' };
  const operations = threadOperations(
    ports<ThreadPorts>({
      threads: {
        prompt: async () => ({ status: 'accepted', promptId }),
        resume: async () => ({ status: 'resumed', thread }),
        rewind: async () => ({ status: 'accepted', promptId }),
      },
    }),
  );
  assert.deepEqual(
    await operations.prompt(input({ id: threadId }, { prompt: 'Go' })),
    { kind: 'ok', status: 202, value: { promptId } },
  );
  assert.deepEqual(
    await operations.resume(input({ id: threadId }, { promptId })),
    { kind: 'ok', status: 202, value: thread },
  );
  assert.deepEqual(
    await operations.rewind(
      input({ id: threadId }, { promptId, prompt: 'Again' }),
    ),
    { kind: 'ok', status: 202, value: { promptId } },
  );
});

test('K2: DeleteQueuedPrompt answers 204', async () => {
  const operations = threadOperations(
    ports<ThreadPorts>({ threads: { removeQueued: async () => 'removed' } }),
  );
  assert.deepEqual(
    await operations.removeQueued(input({ id: threadId, promptId })),
    { kind: 'ok', status: 204, value: undefined },
  );
});

test('K2/Q8: DeleteThread answers 204 for deleted and forbidden, and refuses active', async () => {
  const remove = (result: string) =>
    threadOperations(
      ports<ThreadPorts>({ threads: { deleteThread: async () => result } }),
    ).remove(input({ id: threadId }));

  for (const result of ['deleted', 'forbidden']) {
    assert.deepEqual(
      await remove(result),
      { kind: 'ok', status: 204, value: undefined },
      result,
    );
  }
  assert.deepEqual(
    await remove('active'),
    refused(409, 'thread_active', 'The thread cannot perform this operation.'),
  );
  assert.deepEqual(
    await remove('missing'),
    refused(404, 'thread_not_found', 'The thread was not found.'),
  );
});

test("K2: GetGit answers 200 {status: 'pending'} for a pending Thread lease, as today", async () => {
  const operations = threadOperations(
    ports<ThreadPorts>({
      git: () => ({ status: async () => ({ status: 'pending' }) }),
    }),
  );
  assert.deepEqual(await operations.git(input({ id: threadId })), {
    kind: 'ok',
    status: 200,
    value: { status: 'pending' },
  });
});

test('K2: CreateCredential answers 201 and DeleteCredential 204', async () => {
  const description = {
    id: projectId,
    kind: 'API_TOKEN',
    name: 'Token',
    hasSecret: true,
  };
  const operations = credentialOperations(
    ports<Pick<TransportPorts, 'secrets'>>({
      secrets: {
        kinds: async () => [
          { id: 'API_TOKEN', required: ['secret'], optional: [] },
        ],
        create: async () => description,
        delete: async () => 'deleted',
      },
    }),
  );
  assert.deepEqual(
    await operations.create(
      input({}, { kind: 'API_TOKEN', name: 'Token', secret: 'value' }),
    ),
    { kind: 'ok', status: 201, value: description },
  );
  assert.deepEqual(await operations.remove(input({ id: projectId })), {
    kind: 'ok',
    status: 204,
    value: undefined,
  });
});

test("K2: a refusal thrown by secrets/v1 is answered with today's 409, not thrown", async () => {
  const operations = credentialOperations(
    ports<Pick<TransportPorts, 'secrets'>>({
      secrets: {
        kinds: async () => [
          { id: 'API_TOKEN', required: ['secret'], optional: [] },
        ],
        create: async () => {
          throw new ContractError('credential_name_taken', 'Taken.');
        },
      },
    }),
  );
  assert.deepEqual(
    await operations.create(
      input({}, { kind: 'API_TOKEN', name: 'Token', secret: 'value' }),
    ),
    refused(
      409,
      'credential_name_taken',
      'The credential cannot perform this operation.',
    ),
  );
});

test('K2: CreateTerminal answers 201; SendInput, Resize and DeleteTerminal 204', async () => {
  const session = { id: terminalId, threadId, cols: 80, rows: 24 };
  const operations = terminalOperations(
    ports<Pick<TransportPorts, 'terminal'>>({
      terminal: {
        create: async () => session,
        input: async () => true,
        resize: async () => true,
        stop: async () => undefined,
      },
    }),
  );
  assert.deepEqual(
    await operations.create(input({ id: threadId }, { cols: 80, rows: 24 })),
    { kind: 'ok', status: 201, value: session },
  );
  const empty = { kind: 'ok', status: 204, value: undefined };
  assert.deepEqual(
    await operations.input(input({ id: terminalId }, { data: 'ls\r' })),
    empty,
  );
  assert.deepEqual(
    await operations.resize(input({ id: terminalId }, { cols: 100, rows: 30 })),
    empty,
  );
  assert.deepEqual(await operations.stop(input({ id: terminalId })), empty);
});

test("K2: PutConfig answers a failed activation with today's 503, and GetConfig 200", async () => {
  const configuration = { providers: [] };
  const operations = configOperations(
    ports<Pick<TransportPorts, 'configuration'>>({
      configuration: {
        current: async () => configuration,
        replace: async () => {
          throw new Error('activation failed');
        },
      },
    }),
  );
  assert.deepEqual(await operations.current(input({})), {
    kind: 'ok',
    status: 200,
    value: configuration,
  });
  assert.deepEqual(
    await operations.replace(input({}, configuration)),
    refused(
      503,
      'configuration_rejected',
      'The Doric configuration could not be activated.',
    ),
  );
});
