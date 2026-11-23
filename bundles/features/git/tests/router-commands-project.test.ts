// `git.commands/v1`'s Project methods through the router (phase 3, slice
// S55c, tests C10–C13): `Changes`, `Diff` and `FileDiff` run on the current
// sandbox of the call's Project lease, used with the scope `{projectId}` only
// (D3): one `Describe{target: {}}`, every step bound with `expectSandboxId`,
// a lease state (or a drop between steps) is the answer, and any other
// failure fails the call.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import { leaseScopeMessage } from 'runtime/contracts';

import {
  type CommandsHarness,
  type CommandsHarnessOptions,
  commandsHarness,
} from './support/router-commands.js';
import { repository } from './support/runtime.js';

type Repository = Awaited<ReturnType<typeof repository>>;

/** A repository with `a.txt` and `sub/b.txt` committed, then `a.txt` edited. */
const changed = async (t: TestContext): Promise<Repository> => {
  const repo = await repository(t);
  await mkdir(join(repo.root, 'sub'));
  await writeFile(join(repo.root, 'a.txt'), 'a\n');
  await writeFile(join(repo.root, 'sub', 'b.txt'), 'b\n');
  await repo.git('add', '.');
  await repo.git('commit', '-qm', 'Initial commit');
  await writeFile(join(repo.root, 'a.txt'), 'edited\n');
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

/** The three Project methods, each on a readable target. */
const projectCalls = (h: CommandsHarness) => {
  const client = h.client();
  return {
    changes: () => client.changes({}),
    diff: () => client.diff({}),
    fileDiff: () => client.fileDiff({ repository: '', path: 'a.txt' }),
  };
};

void test('C10: each Project method uses the lease with scope {projectId} only, one Describe{target: {}}, and expectSandboxId on every step', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo);

  for (const [name, call] of Object.entries(projectCalls(h))) {
    h.calls.length = 0;
    const answer = (await call()) as {
      status: string;
      value?: { status: string };
    };

    assert.equal(answer.status, 'ready', name);
    assert.equal(answer.value?.status, 'read', name);
    const leaseCalls = h.callsOf('lease');
    for (const call of leaseCalls)
      assert.deepEqual(call.scope, { projectId: 'project-1' }, name);
    assert.deepEqual(
      h.callsOf('lease', 'describe').map((call) => call.request),
      [{ target: {} }],
      name,
    );
    const steps = leaseCalls.filter((call) => call.method !== 'describe');
    assert.ok(steps.length > 0, name);
    for (const step of steps)
      assert.deepEqual(
        (step.request as { target: unknown }).target,
        { expectSandboxId: 'sandbox-1' },
        name,
      );
    assert.deepEqual(h.callsOf('workspace'), [], name);
  }
});

void test('C10: Diff reads the tracked diff through the lease Diff step', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo);

  const answer = await h.client().diff({});

  assert.equal(answer.value?.status, 'read');
  assert.equal(answer.value?.repositories.length, 1);
  assert.match(answer.value?.repositories[0]?.diff ?? '', /\+edited/);
  assert.ok(h.callsOf('lease', 'diff').length > 0);
});

void test('C11: without a projectId, Changes and Diff fail invalid_input with the lease scope sentence and no lease call', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo);
  const client = h.client({ threadId: 'thread-1' });

  for (const call of [client.changes({}), client.diff({ path: 'sub' })]) {
    const error = await rejectionOf(call);
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, leaseScopeMessage);
  }
  const fileDiff = await rejectionOf(
    client.fileDiff({ repository: '', path: 'a.txt' }),
  );
  assert.equal(fileDiff.code, 'invalid_input');
  assert.deepEqual(h.callsOf('lease'), []);
});

void test('C11: FileDiff of ../x answers ready invalid_path without a scope and without a call', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo);

  const answer = await h
    .client({ threadId: 'thread-1' })
    .fileDiff({ repository: '', path: '../x' });

  assert.equal(answer.status, 'ready');
  assert.equal(answer.value?.status, 'invalid_path');
  assert.equal(answer.value?.diff, undefined);
  assert.deepEqual(h.calls, []);
});

void test('C12: each Project method under each non-ready lease state answers that status with no value', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo);

  for (const state of [
    'pending',
    'unavailable',
    'expired',
    'missing',
  ] as const) {
    h.state.lease = state;
    for (const [name, call] of Object.entries(projectCalls(h))) {
      const answer = (await call()) as { status: string; value?: unknown };
      assert.equal(answer.status, state, `${name} ${state}`);
      assert.equal(answer.value, undefined, `${name} ${state}`);
    }
  }
  assert.deepEqual(
    h.calls.filter((call) => call.method !== 'describe'),
    [],
  );
});

void test('C12: a sandbox switched after Describe answers unavailable for each Project method', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo);

  for (const [name, call] of Object.entries(projectCalls(h))) {
    h.state.sandboxId = 'sandbox-1';
    h.state.switchAfterDescribe = 'sandbox-2';
    const answer = (await call()) as { status: string; value?: unknown };
    assert.equal(answer.status, 'unavailable', name);
    assert.equal(answer.value, undefined, name);
  }
});

void test('C13: a step failing internal (not a lease failure) fails Changes, Diff and FileDiff internal', async (t) => {
  const repo = await changed(t);
  const h = await activated(t, repo, {
    state: { stepError: new ContractError('internal', 'The sandbox broke.') },
  });

  for (const [name, call] of Object.entries(projectCalls(h))) {
    h.calls.length = 0;
    const error = await rejectionOf(call());
    assert.equal(error.code, 'internal', name);
    assert.equal(error.message, 'The sandbox broke.', name);
    assert.equal(h.callsOf('lease', 'describe').length, 1, name);
    assert.ok(
      h.callsOf('lease').some((call) => call.method !== 'describe'),
      name,
    );
  }
});
