// The layout's host adapter: every outcome shows the message the REST path
// showed (R-ERR), the main process's payload guards still run first, lists
// read every page and deletes wait for the lifecycle.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type {
  DeleteResult,
  Page,
  Project,
  Thread,
  ThreadCreateResult,
} from 'runtime/contracts';

import type { RuntimeHost, ThreadsHost } from '../src/client/api/host.js';
import {
  createWorkspaceApi,
  hostFailure,
} from '../src/client/api/workspace-api.js';

const projectId = '6f1d2c8e-4b7a-4c1e-9d2f-1a2b3c4d5e6f';
const threadId = '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const parentId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

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
  name: 'Main',
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
};

const unexpected = (): never => {
  throw new Error('the host was not expected to be called');
};

const runtimeHost = (overrides: Partial<RuntimeHost> = {}): RuntimeHost => ({
  projects: unexpected,
  projectActivity: unexpected,
  createProject: unexpected,
  renameProject: unexpected,
  setProjectColor: unexpected,
  terminateProject: unexpected,
  deleteProject: unexpected,
  watchProject: unexpected,
  ...overrides,
});

const threadsHost = (overrides: Partial<ThreadsHost> = {}): ThreadsHost => ({
  threads: unexpected,
  thread: unexpected,
  createThread: unexpected,
  renameThread: unexpected,
  terminateThread: unexpected,
  deleteThread: unexpected,
  ...overrides,
});

const adapter = (
  runtime: Partial<RuntimeHost> = {},
  threads: Partial<ThreadsHost> = {},
) =>
  createWorkspaceApi({
    runtime: runtimeHost(runtime),
    threads: threadsHost(threads),
    pause: async () => undefined,
  });

const rejectsWith = (promise: Promise<unknown>, message: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    return true;
  });

describe('host failures', () => {
  const cases: readonly [string, ContractError, string][] = [
    [
      'an unreachable host',
      new ContractError('unavailable', 'Doric backend is unavailable.'),
      'Doric backend is unavailable.',
    ],
    [
      'a dropped bridge',
      new ContractError('disconnected', 'The host bridge disconnected.'),
      'Doric backend is unavailable.',
    ],
    [
      'a host generation that ended',
      new ContractError('generation_lost', 'The generation ended.'),
      'Doric backend is unavailable.',
    ],
    [
      'an answer the contract rejects',
      new ContractError('invalid_output', 'Invalid output.'),
      'Doric returned an invalid response.',
    ],
    [
      'any other host error',
      new ContractError('internal', 'Something internal and private.'),
      'The request could not be completed.',
    ],
  ];

  for (const [name, error, message] of cases) {
    test(`${name} shows "${message}"`, async () => {
      assert.equal(hostFailure(error).message, message);
      await rejectsWith(
        adapter({
          projects: async () => {
            throw error;
          },
        }).projects.list(),
        message,
      );
    });
  }
});

describe('lists', () => {
  test('reads every page in order', async () => {
    const pages: Record<string, Page<Project>> = {
      first: { items: [{ ...project, id: 'a' }], nextCursor: 'c1' },
      c1: { items: [{ ...project, id: 'b' }], nextCursor: 'c2' },
      c2: { items: [{ ...project, id: 'c' }] },
    };
    const projects = await adapter({
      projects: async ({ cursor }) => pages[cursor ?? 'first'] as Page<Project>,
    }).projects.list();

    assert.deepEqual(
      projects.map(({ id }) => id),
      ['a', 'b', 'c'],
    );
  });

  test('a repeated cursor is an invalid response', async () => {
    await rejectsWith(
      adapter({
        projects: async () => ({ items: [project], nextCursor: 'loop' }),
      }).projects.list(),
      'Doric returned an invalid response.',
    );
  });

  test("a Project's Threads of a Project that is gone is a missing Project", async () => {
    await rejectsWith(
      adapter({}, { threads: async () => undefined }).threads.list(projectId),
      'The project was not found.',
    );
  });
});

describe('payload guards and route checks', () => {
  test('a name is trimmed before it reaches the host', async () => {
    const names: string[] = [];
    await adapter({
      createProject: async ({ name }) => {
        names.push(name);
        return project;
      },
    }).projects.create('  Project  ');

    assert.deepEqual(names, ['Project']);
  });

  const names: readonly [string, unknown, string][] = [
    ['an empty name', '   ', 'Enter a name between 1 and 80 characters.'],
    [
      'a name over 80 characters',
      'x'.repeat(81),
      'Enter a name between 1 and 80 characters.',
    ],
    [
      'a name with a null character',
      'a\0b',
      'Enter a valid name before continuing.',
    ],
  ];

  for (const [name, value, message] of names) {
    test(`${name} is refused before the host`, async () => {
      await rejectsWith(adapter().projects.create(value as string), message);
      await rejectsWith(
        adapter().threads.rename(threadId, value as string),
        message,
      );
    });
  }

  test('80 characters is a valid name', async () => {
    const created = await adapter({
      createProject: async ({ name }) => ({ ...project, name }),
    }).projects.create('x'.repeat(80));

    assert.equal(created.name.length, 80);
  });

  test('an empty identifier is refused before the host', async () => {
    await rejectsWith(
      adapter().projects.terminate(''),
      'The item identifier is invalid.',
    );
  });

  test('an identifier that is not a UUID is the route ID error', async () => {
    await rejectsWith(
      adapter().projects.rename('not-a-uuid', 'Name'),
      'The project ID is invalid.',
    );
    await rejectsWith(
      adapter().threads.get('not-a-uuid'),
      'The thread ID is invalid.',
    );
  });

  test('a color outside the palette is refused', async () => {
    await rejectsWith(
      adapter().projects.setColor(projectId, 'black' as never),
      'Choose a color from the palette.',
    );
  });

  test('no color clears the color', async () => {
    const colors: unknown[] = [];
    await adapter({
      setProjectColor: async ({ color }) => {
        colors.push(color);
        return project;
      },
    }).projects.setColor(projectId);

    assert.deepEqual(colors, [null]);
  });
});

describe('outcomes', () => {
  test('a write to a Project that is gone is the REST 404 message', async () => {
    const api = adapter({
      renameProject: async () => undefined,
      setProjectColor: async () => undefined,
      terminateProject: async () => undefined,
    });

    await rejectsWith(
      api.projects.rename(projectId, 'Name'),
      'The project was not found.',
    );
    await rejectsWith(
      api.projects.setColor(projectId, 'red'),
      'The project was not found.',
    );
    await rejectsWith(
      api.projects.terminate(projectId),
      'The project was not found.',
    );
  });

  test('a write to a Thread that is gone is the REST 404 message', async () => {
    const api = adapter(
      {},
      {
        renameThread: async () => undefined,
        terminateThread: async () => undefined,
      },
    );

    await rejectsWith(
      api.threads.rename(threadId, 'Name'),
      'The thread was not found.',
    );
    await rejectsWith(
      api.threads.terminate(threadId),
      'The thread was not found.',
    );
  });

  test('a Thread that no longer exists reads as undefined', async () => {
    const api = adapter({}, { thread: async () => undefined });

    assert.equal(await api.threads.get(threadId), undefined);
  });

  const creates: readonly [ThreadCreateResult['status'], string][] = [
    ['missing', 'The project was not found.'],
    ['inactive', 'The thread cannot perform this operation.'],
    ['invalid_parent', 'The thread cannot perform this operation.'],
  ];

  for (const [status, message] of creates) {
    test(`a create answered "${status}" shows "${message}"`, async () => {
      await rejectsWith(
        adapter(
          {},
          {
            createThread: async () => ({ status }) as ThreadCreateResult,
          },
        ).threads.create(projectId, 'Child', parentId),
        message,
      );
    });
  }

  test('a parent that is not a UUID is the REST body error', async () => {
    await rejectsWith(
      adapter().threads.create(projectId, 'Child', 'parent'),
      'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
    );
  });

  test('a created Thread is answered with its record', async () => {
    const created = await adapter(
      {},
      {
        createThread: async ({ name, parentThreadId }) => ({
          status: 'created',
          thread: { ...thread, name, parentThreadId },
        }),
      },
    ).threads.create(projectId, 'Child', parentId);

    assert.equal(created.name, 'Child');
    assert.equal(created.parentThreadId, parentId);
  });

  test('an initial unnamed Thread retains its empty name', async () => {
    const created = await adapter(
      {},
      {
        createThread: async ({ name }) => ({
          status: 'created',
          thread: { ...thread, name },
        }),
      },
    ).threads.create(projectId, '');
    assert.equal(created.name, '');
  });
});

describe('deletes', () => {
  test('a delete waits while the lifecycle is still active', async () => {
    const answers: DeleteResult[] = ['active', 'active', 'deleted'];
    let pauses = 0;
    const api = createWorkspaceApi({
      runtime: runtimeHost({
        deleteProject: async () => answers.shift() ?? 'deleted',
      }),
      threads: threadsHost(),
      pause: async () => {
        pauses += 1;
      },
    });

    await api.projects.delete(projectId);

    assert.equal(answers.length, 0);
    assert.equal(pauses, 2);
  });

  test('deleting what is gone is the REST 404 message', async () => {
    await rejectsWith(
      adapter({ deleteProject: async () => 'missing' }).projects.delete(
        projectId,
      ),
      'The project was not found.',
    );
    await rejectsWith(
      adapter({}, { deleteThread: async () => 'missing' }).threads.delete(
        threadId,
      ),
      'The thread was not found.',
    );
  });
});
