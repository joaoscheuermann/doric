// The window's side of git (stage 10, §3.8): the calls over git.commands/v1
// answer what the REST client answered for each route status (lease states
// and refusals are data, `pending` carries `Retry-After: 1`, a Thread without
// a runtime or a lease is the 200 body, a failed call is the route's
// sentence), and the changes read the Changes view and the files tree share.
// From slice S65c the window reaches `git.commands/v1` as the generated
// `CommandsService` over Connect (`support/commands-connect.ts`): the calls
// below go through the client part's `gitApiOf(services)`, and the host
// behind it is today's `git.commands/v1` written with the host's codec.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import { gitApiOf, gitMessages } from '../src/client/api/git-api.js';
import { createGitStore } from '../src/client/changes/store.js';
import type { ChangesObservation, Git } from '../src/contracts/index.js';
import { commandsOver, gitWindow } from './support/commands-connect.js';
import { connectFailure } from './support/connect.js';
import { fakeRuntime, gitOver, repository } from './support/runtime.js';

/** The client part's calls over Connect to today's `git` behind the host. */
const apiOver = (git: (scope: { readonly projectId?: string }) => Git) =>
  gitApiOf(gitWindow(commandsOver(git)).services);

const dirty = async (t: Parameters<typeof repository>[0]) => {
  const repo = await repository(t);
  await writeFile(join(repo.root, 'a.ts'), 'one\n');
  await repo.git('add', '.');
  await repo.git('commit', '-qm', 'initial');
  await writeFile(join(repo.root, 'a.ts'), 'two\n');
  return repo;
};

describe('the window over git.commands/v1', () => {
  test('reads changes and comparisons, and lease states as data', async (t) => {
    const repo = await dirty(t);
    const runtime = fakeRuntime({ cwd: repo.root });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);
    const api = apiOver(git);

    const changes = await api.changes('project-1');
    assert.equal(changes.status, 'ready');
    assert.equal(
      changes.status === 'ready'
        ? changes.changes.repositories[0]?.changes[0]?.path
        : undefined,
      'a.ts',
    );
    const diff = await api.fileDiff('project-1', '', 'a.ts');
    assert.equal(
      diff.status === 'ready' ? diff.diff.modified : diff.status,
      'two\n',
    );
    assert.deepEqual(await api.changes('project-1', 'missing'), {
      status: 'not_found',
    });
    // The root sends no path, and the content route needs one.
    assert.deepEqual(await api.fileDiff('project-1', '', ''), {
      status: 'invalid_path',
    });

    runtime.lease = 'pending';
    assert.deepEqual(await api.changes('project-1'), {
      status: 'pending',
      retryAfterSeconds: 1,
    });
    runtime.lease = 'expired';
    assert.deepEqual(await api.fileDiff('project-1', '', 'a.ts'), {
      status: 'expired',
    });
  });

  test('reads a Thread summary and branches, and its states as the route bodies', async (t) => {
    const repo = await dirty(t);
    const runtime = fakeRuntime({ cwd: repo.root });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);
    const api = apiOver(git);

    const summary = await api.git('thread-1');
    assert.equal(summary.repo && summary.head, 'main');
    assert.equal(
      (await api.branches('thread-1')).branches.find((branch) => branch.current)
        ?.name,
      'main',
    );

    runtime.thread = 'pending';
    assert.deepEqual(await api.git('thread-1'), {
      repo: false,
      status: 'pending',
    });
    assert.deepEqual(await api.branches('thread-1'), {
      status: 'pending',
      branches: [],
      blocked: 'Preparing environment…',
    });
    runtime.thread = 'inactive';
    assert.deepEqual(await api.git('thread-1'), {
      repo: false,
      status: 'unavailable',
    });
    assert.deepEqual(await api.branches('thread-1'), {
      status: 'unavailable',
      branches: [],
      blocked: 'Environment unavailable.',
    });
    await assert.rejects(api.switchBranch('thread-1', 'main', repo.root), {
      message: 'The thread cannot perform this operation.',
    });
    runtime.thread = 'missing';
    for (const read of [
      api.git('thread-1'),
      api.branches('thread-1'),
      api.switchBranch('thread-1', 'main', repo.root),
    ])
      await assert.rejects(read, { message: 'The thread was not found.' });
  });

  test('shows a refused switch as its sentence', async (t) => {
    const repo = await dirty(t);
    const { git, dispose } = gitOver(
      repo.sandbox,
      fakeRuntime({ cwd: repo.root }),
    );
    t.after(dispose);
    await assert.rejects(
      apiOver(git).switchBranch('thread-1', 'gone', repo.root),
      { message: 'This local branch no longer exists.' },
    );
  });

  test('answers a Discard with the host outcome unchanged', async (t) => {
    const repo = await dirty(t);
    const runtime = fakeRuntime({ cwd: repo.root });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);
    const api = apiOver(git);
    const discard = (cwd = repo.root) =>
      api.discard({
        threadId: 'thread-1',
        cwd,
        repository: '',
        paths: ['a.ts'],
      });

    assert.deepEqual(await discard(`${repo.root}/elsewhere`), {
      status: 'refused',
      message:
        'The working directory changed. Reopen the Changes view and try again.',
    });
    assert.deepEqual(await discard(), {
      status: 'ready',
      value: { discarded: ['a.ts'] },
    });
    runtime.thread = 'inactive';
    assert.deepEqual(await discard(), { status: 'inactive' });
    runtime.thread = 'missing';
    assert.deepEqual(await discard(), { status: 'missing' });
  });

  test('refuses what the main process refused, before calling the host', async () => {
    const window = gitWindow(
      commandsOver(() => {
        throw new Error('the host must not be called');
      }),
    );
    const api = gitApiOf(window.services);
    await assert.rejects(api.switchBranch('thread-1', '-f', '/workspace'), {
      message: gitMessages.invalidBranch,
    });
    await assert.rejects(api.switchBranch('thread-1', 'main', '  '), {
      message: gitMessages.invalidWorkingDirectory,
    });
    await assert.rejects(api.git(''), {
      message: gitMessages.invalidIdentifier,
    });
    await assert.rejects(api.changes('project-1', '../up'), {
      message: gitMessages.invalidPath,
    });
    assert.deepEqual(window.calls, [], 'The window called the host.');
  });

  test('shows a lost backend and any other host failure as the REST client did', async () => {
    let failure = new ContractError('unavailable', 'bridge closed');
    const window = gitWindow({
      changes: async () => {
        throw connectFailure(failure);
      },
    });
    const api = gitApiOf(window.services);

    await assert.rejects(api.changes('project-1'), {
      message: 'Doric backend is unavailable.',
    });
    failure = new ContractError(
      'internal',
      'Could not read repository changes.',
    );
    await assert.rejects(api.changes('project-1'), {
      message: 'The request could not be completed.',
    });
  });

  // A read that never turns ready fails here rather than holding the run.
  test('the changes read loads, answers, and stops rereading once unobserved', {
    timeout: 20_000,
  }, async (t) => {
    const repo = await dirty(t);
    const runtime = fakeRuntime({ cwd: repo.root });
    const { git, dispose } = gitOver(repo.sandbox, runtime);
    t.after(dispose);
    const store = createGitStore(() => apiOver(git));
    t.after(() => store.dispose());

    const states: ChangesObservation[] = [];
    const settled = new Promise<void>((resolve) => {
      const observation = store.observeChanges(
        { projectId: 'project-1' },
        (state) => {
          states.push(state);
          if (state.read.status === 'ready' && !state.fetching) {
            observation.dispose();
            resolve();
          }
        },
      );
    });
    await settled;
    assert.equal(states[0]?.read.status, 'loading');
    const last = states.at(-1);
    assert.equal(
      last?.read.status === 'ready'
        ? last.read.value.repositories[0]?.added
        : undefined,
      1,
    );
    const reads = runtime.leases.length;
    await store.refresh('project-1', false);
    assert.equal(runtime.leases.length, reads);
  });
});
