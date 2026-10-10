// The provisional features' host adapter (R-ERR, R-DATA): for each host
// outcome, the answer or message the renderer got from the main process's
// REST client for the route's status, and the main process's payload guards.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type CallScope, ContractError } from 'bundle/contracts';
import type {
  ProjectChanges,
  ProjectFile,
  ProjectFiles,
  ProjectTree,
  Terminal,
  ThreadGitResult,
} from 'runtime/contracts';

import {
  createProvisionalApi,
  type ProvisionalHosts,
} from '../src/client/provisional/api/provisional-api.js';

type Hosts = {
  -readonly [Key in keyof ProvisionalHosts]: ProvisionalHosts[Key];
};

const unexpected = async (): Promise<never> => {
  throw new Error('not expected in this case');
};

const terminal: Terminal = {
  id: 'terminal',
  projectId: 'project',
  threadId: 'thread',
  origin: 'user',
  command: 'zsh',
  cwd: '/workspace',
  startedAt: '2026-10-03T00:00:00Z',
  timeoutMs: null,
  state: 'running',
  pty: true,
};

/** Hosts whose every call fails unless a case overrides it. */
const hosts = (
  lease: Partial<ReturnType<ProvisionalHosts['lease']>> = {},
  rest: Partial<Omit<Hosts, 'lease'>> = {},
  scopes: CallScope[] = [],
): ProvisionalHosts => ({
  lease: (scope) => {
    scopes.push(scope);
    return {
      files: unexpected,
      tree: unexpected,
      file: unexpected,
      diff: unexpected,
      changes: unexpected,
      fileDiff: unexpected,
      resources: unexpected,
      git: unexpected,
      branches: unexpected,
      ...lease,
    };
  },
  terminals: {
    list: unexpected,
    create: unexpected,
    snapshot: unexpected,
    input: unexpected,
    resize: unexpected,
    stop: unexpected,
    watchProject: () => {
      throw new Error('not expected in this case');
    },
    ...rest.terminals,
  },
  usage: { usage: unexpected, ...rest.usage },
  resources: { host: unexpected, ...rest.resources },
});

const rejects = (promise: Promise<unknown>, message: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    return true;
  });

describe('sandbox reads', () => {
  test('each lease state is data the surface renders', async () => {
    const cases: readonly [ProjectTree['status'], unknown][] = [
      ['missing', { status: 'missing' }],
      ['pending', { status: 'pending', retryAfterSeconds: 1 }],
      ['unavailable', { status: 'unavailable' }],
      ['expired', { status: 'expired' }],
      ['not_found', { status: 'not_found' }],
      ['invalid_path', { status: 'invalid_path' }],
      ['not_directory', { status: 'invalid_path' }],
    ];
    for (const [status, expected] of cases) {
      const api = createProvisionalApi(
        hosts({ tree: async () => ({ status }) as ProjectTree }),
      );
      assert.deepEqual(await api.projects.tree('project'), expected, status);
    }
  });

  test('a file that is not readable is an invalid path', async () => {
    const api = createProvisionalApi(
      hosts({ file: async () => ({ status: 'not_file' }) as ProjectFile }),
    );
    assert.deepEqual(await api.projects.file('project', 'src'), {
      status: 'invalid_path',
    });
  });

  test('reads are scoped to the Project and the root sends no path', async () => {
    const scopes: CallScope[] = [];
    const inputs: unknown[] = [];
    const api = createProvisionalApi(
      hosts(
        {
          files: async (input) => {
            inputs.push(input);
            return {
              status: 'ready',
              path: '',
              entries: [{ name: 'a', path: 'a', type: 'file' }],
            } as ProjectFiles;
          },
        },
        {},
        scopes,
      ),
    );

    const result = await api.projects.files('project');
    await api.projects.files('project', 'src');

    assert.deepEqual(result, {
      status: 'ready',
      path: '',
      entries: [{ name: 'a', path: 'a', type: 'file' }],
    });
    assert.deepEqual(inputs, [{}, { path: 'src' }]);
    assert.deepEqual(scopes[0], { projectId: 'project' });
  });

  test('a file read without a path and a comparison without one are invalid paths', async () => {
    const api = createProvisionalApi(hosts());
    assert.deepEqual(await api.projects.file('project', ''), {
      status: 'invalid_path',
    });
    assert.deepEqual(await api.projects.fileDiff('project', 'repo', ''), {
      status: 'invalid_path',
    });
  });

  test('a ready file carries only its content fields', async () => {
    const api = createProvisionalApi(
      hosts({
        file: async () => ({
          status: 'ready',
          path: 'a.ts',
          content: 'x',
          truncated: false,
          binary: false,
        }),
      }),
    );
    assert.deepEqual(await api.projects.file('project', 'a.ts'), {
      status: 'ready',
      file: { path: 'a.ts', content: 'x', truncated: false, binary: false },
    });
  });

  test('changes keep the repository totals and per-file status', async () => {
    const changes: ProjectChanges = {
      status: 'ready',
      repositories: [
        {
          path: '',
          added: 2,
          removed: 1,
          changes: [
            {
              path: 'a.ts',
              status: 'modified',
              staged: false,
              unstaged: true,
              indexStatus: ' ',
              worktreeStatus: 'M',
            },
          ],
        },
      ],
    };
    const api = createProvisionalApi(hosts({ changes: async () => changes }));
    assert.deepEqual(await api.projects.changes('project'), {
      status: 'ready',
      changes: { repositories: changes.repositories },
    });
  });

  test('a malformed answer is an invalid response', async () => {
    const api = createProvisionalApi(
      hosts({
        tree: async () =>
          ({
            status: 'ready',
            path: '',
            entries: [{ name: 'a', path: 'a', type: 'socket' }],
          }) as unknown as ProjectTree,
      }),
    );
    await rejects(
      api.projects.tree('project'),
      'Doric returned an invalid response.',
    );
  });

  test('the payload guards run before the host is asked', async () => {
    const api = createProvisionalApi(hosts());
    await rejects(api.projects.tree(''), 'The item identifier is invalid.');
    await rejects(
      api.projects.tree('project', '../etc'),
      'The workspace path is invalid.',
    );
    await rejects(
      api.projects.file('project', '/abs'),
      'The workspace path is invalid.',
    );
  });

  test('host failures show the message the route answered', async () => {
    const failing = (error: unknown) =>
      createProvisionalApi(
        hosts({
          tree: async () => {
            throw error;
          },
        }),
      );
    await rejects(
      failing(new ContractError('disconnected', 'gone')).projects.tree('p'),
      'Doric backend is unavailable.',
    );
    await rejects(
      failing(new ContractError('invalid_output', 'bad')).projects.tree('p'),
      'Doric returned an invalid response.',
    );
    await rejects(
      failing(new Error('boom')).projects.tree('p'),
      'The request could not be completed.',
    );
  });
});

describe('Project resources', () => {
  test('a lease state or the container reading', async () => {
    const pending = createProvisionalApi(
      hosts({ resources: async () => ({ status: 'pending' }) }),
    );
    assert.deepEqual(await pending.resources.project('project'), {
      status: 'pending',
      retryAfterSeconds: 1,
    });

    const container = {
      status: 'ready' as const,
      at: '2026-10-03T00:00:00Z',
      cpuPercent: 3,
    };
    const ready = createProvisionalApi(
      hosts({ resources: async () => ({ status: 'ready', container }) }),
    );
    assert.deepEqual(await ready.resources.project('project'), {
      status: 'ready',
      container,
    });
  });
});

describe('Thread git and branches', () => {
  const gitWith = (result: ThreadGitResult, scopes: CallScope[] = []) =>
    createProvisionalApi(hosts({ git: async () => result }, {}, scopes));

  test('a missing Thread is the route 404', async () => {
    await rejects(
      gitWith({ status: 'missing' }).threads.git('thread'),
      'The thread was not found.',
    );
  });

  test('a sandbox not ready yet or gone is a summary without a repository', async () => {
    assert.deepEqual(await gitWith({ status: 'pending' }).threads.git('t'), {
      repo: false,
      status: 'pending',
    });
    assert.deepEqual(await gitWith({ status: 'inactive' }).threads.git('t'), {
      repo: false,
      status: 'unavailable',
    });
  });

  test('git is read with the Thread scope', async () => {
    const scopes: CallScope[] = [];
    await gitWith(
      { status: 'ready', git: { repo: false } },
      scopes,
    ).threads.git('thread');
    assert.deepEqual(scopes, [{ threadId: 'thread' }]);
  });

  test('branches without a live sandbox explain why the list is empty', async () => {
    const pending = createProvisionalApi(
      hosts({ branches: async () => ({ status: 'pending' }) }),
    );
    const inactive = createProvisionalApi(
      hosts({ branches: async () => ({ status: 'inactive' }) }),
    );
    assert.deepEqual(await pending.threads.branches('t'), {
      status: 'pending',
      branches: [],
      blocked: 'Preparing environment…',
    });
    assert.deepEqual(await inactive.threads.branches('t'), {
      status: 'unavailable',
      branches: [],
      blocked: 'Environment unavailable.',
    });
  });

  test('a switch shows the host refusal, or that the Thread cannot do it', async () => {
    const refused = createProvisionalApi(
      hosts({
        branches: async () => ({
          status: 'refused',
          message: 'Commit or stash your changes first.',
        }),
      }),
    );
    const inactive = createProvisionalApi(
      hosts({ branches: async () => ({ status: 'inactive' }) }),
    );
    await rejects(
      refused.threads.switchBranch('t', 'main', '/workspace'),
      'Commit or stash your changes first.',
    );
    await rejects(
      inactive.threads.switchBranch('t', 'main', '/workspace'),
      'The thread cannot perform this operation.',
    );
  });

  test('a switch checks the branch name first, then the Thread and directory', async () => {
    const api = createProvisionalApi(hosts());
    await rejects(
      api.threads.switchBranch('', '-x', '/workspace'),
      'Invalid branch name.',
    );
    await rejects(
      api.threads.switchBranch('', 'main', '/workspace'),
      'The item identifier is invalid.',
    );
    await rejects(
      api.threads.switchBranch('t', 'main', '   '),
      'The working directory is invalid.',
    );
  });
});

describe('Thread usage', () => {
  test('a Thread the host does not know is the route 404', async () => {
    const api = createProvisionalApi(
      hosts({}, { usage: { usage: async () => undefined } }),
    );
    await rejects(api.threads.usage('thread'), 'The thread was not found.');
  });
});

describe('terminals', () => {
  test('a terminal the host could not open or write fails with the terminal sentence', async () => {
    const api = createProvisionalApi(
      hosts(
        {},
        {
          terminals: {
            ...hosts().terminals,
            create: async () => undefined,
            input: async () => false,
            resize: async () => false,
          },
        },
      ),
    );
    const message = 'Doric could not complete the terminal request.';
    await rejects(api.terminals.create('thread'), message);
    await rejects(api.terminals.input('terminal', 'ls\r'), message);
    await rejects(api.terminals.resize('terminal', 80, 24), message);
  });

  test('a lost bridge is the backend being unavailable', async () => {
    const api = createProvisionalApi(
      hosts(
        {},
        {
          terminals: {
            ...hosts().terminals,
            list: async () => {
              throw new ContractError('unavailable', 'down');
            },
          },
        },
      ),
    );
    await rejects(
      api.terminals.list('project'),
      'Doric backend is unavailable.',
    );
  });

  test('the input and dimension guards run before the host is asked', async () => {
    const api = createProvisionalApi(hosts());
    await rejects(
      api.terminals.input('terminal', 'x'.repeat(65_537)),
      'Terminal input is invalid.',
    );
    await rejects(
      api.terminals.resize('terminal', 0, 24),
      'Terminal dimensions are invalid.',
    );
    await rejects(
      api.terminals.resize('terminal', 80, 1001),
      'Terminal dimensions are invalid.',
    );
  });

  test('keystrokes reach one terminal in the order they were typed', async () => {
    const written: string[] = [];
    const pending: (() => void)[] = [];
    const api = createProvisionalApi(
      hosts(
        {},
        {
          terminals: {
            ...hosts().terminals,
            input: ({ data }) =>
              new Promise<boolean>((resolve) => {
                pending.push(() => {
                  written.push(data);
                  resolve(true);
                });
              }),
          },
        },
      ),
    );

    const first = api.terminals.input('terminal', 'a');
    const second = api.terminals.input('terminal', 'b');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 1, 'the second write waits for the first');
    pending.shift()?.();
    await first;
    await new Promise<void>((resolve) => setImmediate(resolve));
    pending.shift()?.();
    await second;

    assert.deepEqual(written, ['a', 'b']);
  });

  test('a listed terminal keeps only the record fields', async () => {
    const api = createProvisionalApi(
      hosts(
        {},
        {
          terminals: {
            ...hosts().terminals,
            list: async () => [{ ...terminal, extra: 1 } as Terminal],
          },
        },
      ),
    );
    assert.deepEqual(await api.terminals.list('project'), [terminal]);
  });
});
