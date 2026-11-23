// `git.commands/v1`'s Thread methods through the router (phase 3, slice S55c,
// tests C1–C9): `Status`, `Branches`, `SwitchBranch` and `Discard` each run
// in one Thread session (`OpenThread`, D2) whose `Describe` gives the root
// and whose every step targets the session; the busy check reads
// `ThreadState` and the optional `terminal/v1` (D6); an empty `threadId` is
// `missing` without a call (D8). Each case runs on a real repository.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';

import {
  type CommandsHarness,
  type CommandsHarnessOptions,
  commandsHarness,
} from './support/router-commands.js';
import { repository, terminal } from './support/runtime.js';

const branchBusy =
  'Wait for active prompts and terminal commands in this worktree to finish before switching branches.';
const discardBusy =
  'Wait for active prompts and terminal commands in this repository to finish before discarding changes.';
const staleCwd =
  'The working directory changed. Reopen the branch picker and try again.';

type Repository = Awaited<ReturnType<typeof repository>>;

/** A repository with `a.txt` committed on `main` and a `feature` branch. */
const committed = async (t: TestContext): Promise<Repository> => {
  const repo = await repository(t);
  await writeFile(join(repo.root, 'a.txt'), 'a\n');
  await repo.git('add', '.');
  await repo.git('commit', '-qm', 'Initial commit');
  await repo.git('branch', 'feature');
  return repo;
};

const activated = async (
  t: TestContext,
  repo: Repository,
  options: Omit<CommandsHarnessOptions, 'sandbox'> = {},
): Promise<CommandsHarness> => {
  const h = commandsHarness({ sandbox: repo.sandbox, ...options });
  t.after(() => h.router.control.stop());
  await h.activate();
  return h;
};

/** The Doric error `promise` rejects with; fails the test when it resolves. */
const rejectionOf = async (
  promise: Promise<unknown>,
): Promise<ContractError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectError) return fromConnectError(error);
    assert.ok(isContractError(error), `expected a Doric error: ${error}`);
    return error;
  }
  return assert.fail('the call succeeded');
};

/** The four Thread methods on `thread`, each answering its `status` (and `message`). */
const threadCalls = (h: CommandsHarness, threadId: string, cwd: string) => {
  const client = h.client();
  return {
    status: () => client.status({ threadId }),
    branches: () => client.branches({ threadId }),
    switchBranch: () =>
      client.switchBranch({ threadId, branch: 'feature', cwd }),
    discard: () =>
      client.discard({ threadId, cwd, repository: '', paths: [], all: true }),
  };
};

const current = async (repo: Repository) =>
  (await repo.git('branch', '--show-current')).trim();

void test('C1: before activate, every method fails unavailable and makes no call', async (t) => {
  const repo = await committed(t);
  const h = commandsHarness({ sandbox: repo.sandbox });
  t.after(() => h.router.control.stop());
  await h.serveUnactivated();
  const client = h.client();

  const calls: Promise<unknown>[] = [
    ...Object.values(threadCalls(h, 'thread-1', repo.root)).map((call) =>
      call(),
    ),
    client.changes({}),
    client.diff({}),
    client.fileDiff({ repository: '', path: 'a.txt' }),
  ];
  for (const call of calls)
    assert.equal((await rejectionOf(call)).code, 'unavailable');
  assert.deepEqual(h.calls, []);
});

void test('C2: Status opens one non-exclusive session with refreshHint, describes it once, probes on it, and ends it before answering', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo);

  const answer = await h.client().status({ threadId: 'thread-1' });

  assert.deepEqual(
    h.callsOf('workspace', 'openThread').map((call) => call.request),
    [{ threadId: 'thread-1', exclusive: false, refreshHint: true }],
  );
  assert.deepEqual(
    h.callsOf('lease', 'describe').map((call) => call.request),
    [{ target: { threadSessionId: 'session-1' } }],
  );
  const execs = h.callsOf('lease', 'exec');
  assert.ok(execs.length > 0);
  for (const exec of execs)
    assert.deepEqual((exec.request as { target: unknown }).target, {
      threadSessionId: 'session-1',
    });
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0]?.cancelled, true);
  assert.equal(answer.status, 'ready');
  assert.equal(answer.value?.repo, true);
  assert.equal(answer.value?.root, repo.root);
  assert.equal(answer.value?.head, 'main');
  assert.equal(answer.value?.upstream, undefined);
  assert.equal(answer.value?.operation, undefined);
});

void test('C3: a Thread that is missing, inactive or pending is that status alone for every Thread method, with no lease call', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo);

  for (const state of ['missing', 'inactive', 'pending'] as const) {
    h.state.thread = state;
    for (const call of Object.values(threadCalls(h, 'thread-1', repo.root))) {
      const answer = (await call()) as {
        status: string;
        value?: unknown;
        message?: string;
      };
      assert.equal(answer.status, state);
      assert.equal(answer.value, undefined);
      assert.equal(answer.message, undefined);
    }
  }
  assert.deepEqual(h.callsOf('lease'), []);
  assert.deepEqual(h.callsOf('workspace', 'threadState'), []);
});

void test('C3/D8: an empty threadId answers missing for every Thread method without OpenThread', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo);

  for (const call of Object.values(threadCalls(h, '', repo.root)))
    assert.equal(((await call()) as { status: string }).status, 'missing');
  assert.deepEqual(h.calls, []);
});

void test('C4: Branches, SwitchBranch and Discard open exclusive sessions; a stale cwd refuses the switch without git switch', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo);
  const calls = threadCalls(h, 'thread-1', repo.root);

  await calls.branches();
  await calls.discard();
  const switched = await h.client().switchBranch({
    threadId: 'thread-1',
    branch: 'feature',
    cwd: join(repo.root, 'elsewhere'),
  });

  for (const call of h.callsOf('workspace', 'openThread')) {
    const request = call.request as {
      exclusive: boolean;
      refreshHint?: boolean;
    };
    assert.equal(request.exclusive, true);
    assert.notEqual(request.refreshHint, true);
  }
  assert.equal(h.callsOf('workspace', 'openThread').length, 3);
  assert.equal(switched.status, 'refused');
  assert.equal(switched.message, staleCwd);
  assert.equal(
    h
      .callsOf('lease', 'exec')
      .some((call) =>
        (call.request as { request: { cmd: string[] } }).request.cmd.includes(
          'switch',
        ),
      ),
    false,
  );
  assert.equal(await current(repo), 'main');
});

void test('C5: a busy Thread cwd in the repository blocks Branches, refuses SwitchBranch and Discard, read through ThreadState on the session', async (t) => {
  const repo = await committed(t);
  await writeFile(join(repo.root, 'a.txt'), 'edited\n');
  const h = await activated(t, repo, { state: { busyCwds: [repo.root] } });
  const calls = threadCalls(h, 'thread-1', repo.root);

  const branches = await calls.branches();
  assert.equal(branches.status, 'ready');
  assert.equal(branches.value?.blocked, branchBusy);
  const switched = await calls.switchBranch();
  assert.equal(switched.status, 'refused');
  assert.equal(switched.message, branchBusy);
  const discarded = await calls.discard();
  assert.equal(discarded.status, 'refused');
  assert.equal(discarded.message, discardBusy);
  assert.equal(await readFile(join(repo.root, 'a.txt'), 'utf8'), 'edited\n');
  assert.equal(await current(repo), 'main');
  const states = h.callsOf('workspace', 'threadState');
  assert.ok(states.length >= 3);
  for (const call of states)
    assert.match(
      (call.request as { threadSessionId: string }).threadSessionId,
      /^session-\d+$/,
    );
});

void test('C5: a running agent terminal in the repository blocks; a manual bash or an exited one does not', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo, {
    state: {
      terminals: [
        terminal({ cwd: repo.root, origin: 'agent', state: 'running' }),
      ],
    },
  });
  const calls = threadCalls(h, 'thread-1', repo.root);

  assert.equal((await calls.branches()).value?.blocked, branchBusy);
  assert.equal((await calls.switchBranch()).message, branchBusy);
  assert.equal((await calls.discard()).message, discardBusy);
  assert.deepEqual(
    h.callsOf('terminal', 'list').map((call) => call.request),
    [
      { projectId: 'project-1' },
      { projectId: 'project-1' },
      { projectId: 'project-1' },
    ],
  );

  h.state.terminals = [
    terminal({ cwd: repo.root, origin: 'user', command: 'bash' }),
    terminal({ cwd: repo.root, origin: 'agent', state: 'exited' }),
  ];
  const free = await calls.branches();
  assert.equal(free.status, 'ready');
  assert.equal(free.value?.blocked, undefined);
});

void test('C6: without a terminal/v1 provider the busy check uses Threads only and the call answers', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo, { terminal: false });

  const branches = await h.client().branches({ threadId: 'thread-1' });

  assert.equal(branches.status, 'ready');
  assert.equal(branches.value?.blocked, undefined);
  assert.deepEqual(
    branches.value?.branches.map((branch) => [branch.name, branch.current]),
    [
      ['feature', false],
      ['main', true],
    ],
  );
});

void test('C6: terminal/v1.List failing internal fails the call internal', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo, {
    state: { terminalError: new ContractError('internal', 'List broke.') },
  });

  const error = await rejectionOf(
    h.client().branches({ threadId: 'thread-1' }),
  );

  assert.equal(error.code, 'internal');
  assert.equal(error.message, 'List broke.');
  assert.deepEqual(
    h.callsOf('terminal', 'list').map((call) => call.request),
    [{ projectId: 'project-1' }],
  );
});

void test('C7: SwitchBranch to an existing branch answers ready with it current, and the repository is on it', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo);

  const switched = await h.client().switchBranch({
    threadId: 'thread-1',
    branch: 'feature',
    cwd: repo.root,
  });

  assert.equal(switched.status, 'ready');
  assert.equal(switched.message, undefined);
  assert.equal(
    switched.value?.branches.find((branch) => branch.current)?.name,
    'feature',
  );
  assert.equal(await current(repo), 'feature');
});

void test('C8: Discard all discards every listed change; paths discards only those', async (t) => {
  const repo = await committed(t);
  await writeFile(join(repo.root, 'a.txt'), 'edited\n');
  await writeFile(join(repo.root, 'u.txt'), 'untracked\n');
  const h = await activated(t, repo);
  const client = h.client();
  const request = { threadId: 'thread-1', cwd: repo.root, repository: '' };

  const one = await client.discard({ ...request, paths: ['a.txt'] });
  assert.equal(one.status, 'ready');
  assert.deepEqual(one.value?.discarded, ['a.txt']);
  assert.equal(await readFile(join(repo.root, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(await readFile(join(repo.root, 'u.txt'), 'utf8'), 'untracked\n');

  await writeFile(join(repo.root, 'a.txt'), 'edited again\n');
  const all = await client.discard({ ...request, paths: [], all: true });
  assert.equal(all.status, 'ready');
  assert.deepEqual([...(all.value?.discarded ?? [])].sort(), [
    'a.txt',
    'u.txt',
  ]);
  assert.equal(await repo.git('status', '--porcelain'), '');
});

void test('C8: an explicit empty paths without all is invalid_input before the handler', async (t) => {
  const repo = await committed(t);
  await writeFile(join(repo.root, 'a.txt'), 'edited\n');
  const h = await activated(t, repo);

  const error = await rejectionOf(
    h.client().discard({
      threadId: 'thread-1',
      cwd: repo.root,
      repository: '',
      paths: [],
      all: false,
    }),
  );

  assert.equal(error.code, 'invalid_input');
  assert.deepEqual(h.calls, []);
  assert.equal(await readFile(join(repo.root, 'a.txt'), 'utf8'), 'edited\n');
});

void test('C9: a session ended under the task fails the call unknown_session', async (t) => {
  const repo = await committed(t);
  const h = await activated(t, repo, {
    state: { endSessionAfterDescribe: true },
  });

  const error = await rejectionOf(h.client().status({ threadId: 'thread-1' }));

  assert.equal(error.code, 'unknown_session');
  assert.equal(h.callsOf('lease', 'describe').length, 1);
});
