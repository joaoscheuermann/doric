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
  archiveThread: unexpected,
  restoreThread: unexpected,
  setThreadPinned: unexpected,
  viewThread: unexpected,
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

/**
 * Rejects with the adapters' `ClientError` (spec §6.4): its `code`, the
 * message it had before, and `cause` — the contract error itself, or none.
 */
const rejectsWithClientError = (
  promise: Promise<unknown>,
  expected: {
    readonly code: string;
    readonly message: string;
    readonly cause: unknown;
  },
) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ClientError');
    assert.equal((error as Error & { code?: unknown }).code, expected.code);
    assert.equal(error.message, expected.message);
    assert.equal(error.cause, expected.cause);
    return true;
  });

describe('codes and causes (spec §6.4)', () => {
  test('a contract error other than internal keeps its code and is the cause', async () => {
    for (const [code, message] of [
      ['unavailable', 'Doric backend is unavailable.'],
      ['disconnected', 'Doric backend is unavailable.'],
      ['generation_lost', 'Doric backend is unavailable.'],
      ['invalid_output', 'Doric returned an invalid response.'],
      ['limit_exceeded', 'The request could not be completed.'],
    ] as const) {
      const contract = new ContractError(code, 'what the bridge said');
      await rejectsWithClientError(
        adapter({
          projects: async () => {
            throw contract;
          },
        }).projects.list(),
        { code, message, cause: contract },
      );
      await rejectsWithClientError(
        adapter(
          {},
          {
            renameThread: async () => {
              throw contract;
            },
          },
        ).threads.rename(threadId, 'Name'),
        { code, message, cause: contract },
      );
    }
  });

  test('an internal contract error or a foreign throw is internal, without a cause', async () => {
    for (const thrown of [
      new ContractError('internal', 'Something internal and private.'),
      new Error('boom'),
    ]) {
      await rejectsWithClientError(
        adapter({
          createProject: async () => {
            throw thrown;
          },
        }).projects.create('Name'),
        {
          code: 'internal',
          message: 'The request could not be completed.',
          cause: undefined,
        },
      );
    }
  });

  test('an argument the guards refuse is invalid_input, without a cause', async () => {
    const api = adapter();
    const refused: readonly [() => Promise<unknown>, string][] = [
      [
        () => api.projects.create('   '),
        'Enter a name between 1 and 80 characters.',
      ],
      [
        () => api.projects.create('a\0b'),
        'Enter a valid name before continuing.',
      ],
      [() => api.projects.terminate(''), 'The item identifier is invalid.'],
      [
        () => api.projects.rename('not-a-uuid', 'Name'),
        'The project ID is invalid.',
      ],
      [() => api.threads.get('not-a-uuid'), 'The thread ID is invalid.'],
      [
        () => api.projects.setColor(projectId, 'black' as never),
        'Choose a color from the palette.',
      ],
      [
        () => api.threads.create(projectId, 'Child', 'parent'),
        'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
      ],
    ];
    for (const [call, message] of refused) {
      await rejectsWithClientError(call(), {
        code: 'invalid_input',
        message,
        cause: undefined,
      });
    }
  });

  test('a list whose cursor repeats is invalid_output, without a cause', async () => {
    await rejectsWithClientError(
      adapter({
        projects: async () => ({ items: [project], nextCursor: 'loop' }),
      }).projects.list(),
      {
        code: 'invalid_output',
        message: 'Doric returned an invalid response.',
        cause: undefined,
      },
    );
  });

  test('a target the host reports gone is not_found, without a cause', async () => {
    const gone: readonly [() => Promise<unknown>, string][] = [
      [
        () =>
          adapter({ renameProject: async () => undefined }).projects.rename(
            projectId,
            'Name',
          ),
        'The project was not found.',
      ],
      [
        () =>
          adapter(
            {},
            { terminateThread: async () => undefined },
          ).threads.terminate(threadId),
        'The thread was not found.',
      ],
      [
        () =>
          adapter({}, { threads: async () => undefined }).threads.list(
            projectId,
          ),
        'The project was not found.',
      ],
      [
        () =>
          adapter(
            {},
            {
              createThread: async () =>
                ({ status: 'missing' }) as ThreadCreateResult,
            },
          ).threads.create(projectId, 'Child'),
        'The project was not found.',
      ],
      [
        () =>
          adapter({ deleteProject: async () => 'missing' }).projects.delete(
            projectId,
          ),
        'The project was not found.',
      ],
    ];
    for (const [call, message] of gone) {
      await rejectsWithClientError(call(), {
        code: 'not_found',
        message,
        cause: undefined,
      });
    }
  });

  test('an action the host cannot perform now is conflict, without a cause', async () => {
    for (const status of ['inactive', 'invalid_parent'] as const) {
      await rejectsWithClientError(
        adapter(
          {},
          { createThread: async () => ({ status }) as ThreadCreateResult },
        ).threads.create(projectId, 'Child', parentId),
        {
          code: 'conflict',
          message: 'The thread cannot perform this operation.',
          cause: undefined,
        },
      );
    }
    await rejectsWithClientError(
      adapter({}, { deleteThread: async () => 'forbidden' }).threads.delete(
        threadId,
      ),
      {
        code: 'conflict',
        message:
          'An agent opened this Thread, so it cannot be deleted until it is archived.',
        cause: undefined,
      },
    );
  });
});

describe('archive, restore and pin (T-26, thread-archive §10.6)', () => {
  const batch = 'c0ffee00-1234-4abc-8def-0123456789ab';
  const childId = 'd4c3b2a1-0f9e-4d8c-8b7a-6f5e4d3c2b1a';
  const archived: Thread = {
    ...thread,
    archivedAt: '2026-11-17T12:00:00.000Z',
  };
  const child: Thread = {
    ...archived,
    id: childId,
    parentThreadId: threadId,
  };

  test('an archive answers its batch and every Thread it marked', async () => {
    const asked: unknown[] = [];
    const answer = await adapter(
      {},
      {
        archiveThread: async (input) => {
          asked.push(input);
          return { status: 'archived', batch, threads: [archived, child] };
        },
      },
    ).threads.archive(threadId);

    assert.deepEqual(asked, [{ id: threadId }]);
    assert.equal(answer.batch, batch);
    assert.deepEqual(
      answer.threads.map(({ id }) => id),
      [threadId, childId],
    );
  });

  test('a restore names the batch it undoes, or none', async () => {
    const asked: { readonly id: string; readonly batch?: string }[] = [];
    const api = adapter(
      {},
      {
        restoreThread: async (input) => {
          asked.push(input);
          return { status: 'restored', threads: [thread] };
        },
      },
    );

    const restored = await api.threads.restore(threadId, batch);
    await api.threads.restore(threadId);

    assert.deepEqual(
      restored.map(({ id }) => id),
      [threadId],
    );
    assert.deepEqual(
      asked.map((input) => [input.id, input.batch]),
      [
        [threadId, batch],
        [threadId, undefined],
      ],
    );
  });

  test('a pin answers the record the host wrote', async () => {
    const asked: unknown[] = [];
    const pinned = await adapter(
      {},
      {
        setThreadPinned: async (input) => {
          asked.push(input);
          return { ...thread, pinned: input.pinned };
        },
      },
    ).threads.setPinned(threadId, true);

    assert.deepEqual(asked, [{ id: threadId, pinned: true }]);
    assert.equal(pinned.pinned, true);
  });

  test('a refusal is a ClientError with the message of its status, without a cause', async () => {
    const refusals: readonly [
      string,
      () => Promise<unknown>,
      { readonly code: string; readonly message: string },
    ][] = [
      [
        'archive of a missing Thread',
        () =>
          adapter(
            {},
            { archiveThread: async () => ({ status: 'missing' }) },
          ).threads.archive(threadId),
        { code: 'not_found', message: 'The thread was not found.' },
      ],
      [
        'archive of a busy Thread',
        () =>
          adapter(
            {},
            { archiveThread: async () => ({ status: 'busy' }) },
          ).threads.archive(threadId),
        {
          code: 'conflict',
          message: 'The thread is running, so it cannot be archived.',
        },
      ],
      [
        'archive of an archived Thread',
        () =>
          adapter(
            {},
            { archiveThread: async () => ({ status: 'already_archived' }) },
          ).threads.archive(threadId),
        { code: 'conflict', message: 'The thread is already archived.' },
      ],
      [
        'restore of a missing Thread',
        () =>
          adapter(
            {},
            { restoreThread: async () => ({ status: 'missing' }) },
          ).threads.restore(threadId),
        { code: 'not_found', message: 'The thread was not found.' },
      ],
      [
        'restore of a Thread that is not archived',
        () =>
          adapter(
            {},
            { restoreThread: async () => ({ status: 'not_archived' }) },
          ).threads.restore(threadId, batch),
        { code: 'conflict', message: 'The thread is not archived.' },
      ],
      [
        'pin of a missing Thread',
        () =>
          adapter(
            {},
            { setThreadPinned: async () => undefined },
          ).threads.setPinned(threadId, true),
        { code: 'not_found', message: 'The thread was not found.' },
      ],
    ];

    for (const [name, call, expected] of refusals) {
      await rejectsWithClientError(call(), {
        ...expected,
        cause: undefined,
      }).catch((error: unknown) => {
        throw new Error(`${name}: ${String(error)}`);
      });
    }
  });

  test('a write over the storage batch limit keeps its code and shows the generic message (AC8)', async () => {
    const limit = new ContractError(
      'limit_exceeded',
      'The write exceeds the storage batch limit.',
    );
    const reject = async (): Promise<never> => {
      throw limit;
    };
    const api = adapter(
      {},
      {
        archiveThread: reject,
        restoreThread: reject,
        setThreadPinned: reject,
      },
    );

    for (const call of [
      () => api.threads.archive(threadId),
      () => api.threads.restore(threadId, batch),
      () => api.threads.setPinned(threadId, false),
    ]) {
      await rejectsWithClientError(call(), {
        code: 'limit_exceeded',
        message: 'The request could not be completed.',
        cause: limit,
      });
    }
  });

  test('an id that is not a UUID is refused before the host', async () => {
    const api = adapter();

    for (const call of [
      () => api.threads.archive('not-a-uuid'),
      () => api.threads.restore('not-a-uuid'),
      () => api.threads.setPinned('not-a-uuid', true),
    ]) {
      await rejectsWithClientError(call(), {
        code: 'invalid_input',
        message: 'The thread ID is invalid.',
        cause: undefined,
      });
    }
  });
});
