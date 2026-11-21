import assert from 'node:assert/strict';
import test from 'node:test';

import type { SandboxExecInput, SandboxExecResult } from 'sandbox';

import {
  cwdRepoHint,
  HintProbeIncompleteError,
} from '../../src/host/domain/repository-hint.js';
import { type FakeGitProbe, fakeSandbox } from '../support/sandbox.js';

/*
 * The repository hint of a working directory (bundle isolation 7(c), P1):
 * the hint cases of the provisional `git-status` tests, ported from
 * agents/doric tests/workspace-git.test.ts (design 57 §13.2). The hint stays
 * with the runtime; the Git summary moved to the `git` bundle.
 */

/** The porcelain-v2 document of a clean repository, as Git prints it. */
const clean = [
  '# branch.oid 3dfa01783bf5ed1e051584a6a474c11a1ac8156d',
  '# branch.head main',
].join('\n');

/** A sandbox whose repository `alpha`, with a subdirectory, answers this probe. */
const repositoryAt = (git: FakeGitProbe) =>
  fakeSandbox({
    entries: [{ path: 'alpha' }, { path: 'alpha/src' }],
    repositories: [{ path: 'alpha', git }],
  });

void test('hints at a repository only when the directory holds its own .git marker', async () => {
  const github = repositoryAt({
    status: clean,
    origin: 'git@github.com:owner/repo.git',
  });
  assert.equal(await cwdRepoHint(github, '/workspace/alpha'), 'github');
  // A subdirectory lies in that repository without holding it.
  assert.equal(await cwdRepoHint(github, '/workspace/alpha/src'), undefined);
  assert.equal(await cwdRepoHint(github, '/workspace'), undefined);

  // A linked worktree's marker is a file, and it still counts as a repository.
  const worktree = fakeSandbox({
    entries: [
      { path: 'wt/.git', content: 'gitdir: /workspace/main/.git/worktrees/wt' },
    ],
  });
  assert.equal(await cwdRepoHint(worktree, '/workspace/wt'), 'git');
});

void test('names a repository without a GitHub origin as a repository', async () => {
  assert.equal(
    await cwdRepoHint(repositoryAt({ status: clean }), '/workspace/alpha'),
    'git',
  );
  assert.equal(
    await cwdRepoHint(
      repositoryAt({
        status: clean,
        origin: 'https://notgithub.com/owner/repo.git',
      }),
      '/workspace/alpha',
    ),
    'git',
  );
  assert.equal(
    await cwdRepoHint(
      repositoryAt({ status: clean, origin: '/var/repos/repo' }),
      '/workspace/alpha',
    ),
    'git',
  );
});

/**
 * A repository sandbox whose hint probe answers `answer` instead, recording the
 * exec input the probe passed; every other command goes to the scripted sandbox.
 */
const hintAnswering = (
  answer: (input: SandboxExecInput) => Promise<SandboxExecResult>,
) => {
  const sandbox = repositoryAt({ status: clean });
  const probes: SandboxExecInput[] = [];
  const scripted = sandbox.exec;
  sandbox.exec = async (input: SandboxExecInput) => {
    if (input.cmd[3] !== 'git-hint') return scripted(input);
    probes.push(input);
    return answer(input);
  };
  return { sandbox, probes };
};

const exited = (exitCode: number | null): SandboxExecResult => ({
  exitCode,
  stdout: '',
  stderr: '',
  stdoutBytes: new Uint8Array(),
  stderrBytes: new Uint8Array(),
});

void test('bounds the hint probe at five seconds', async () => {
  const { sandbox, probes } = hintAnswering(async () => ({
    ...exited(0),
    stdout: 'present\n',
  }));
  assert.equal(await cwdRepoHint(sandbox, '/workspace/alpha'), 'git');
  assert.equal(probes.length, 1);
  assert.equal(probes[0]?.timeoutMs, 5000);
});

void test('rejects as incomplete, with the exit code, a hint probe that did not finish', async () => {
  for (const exitCode of [1, null]) {
    const { sandbox } = hintAnswering(async () => exited(exitCode));
    await assert.rejects(
      cwdRepoHint(sandbox, '/workspace/alpha'),
      (error: unknown) => {
        assert.ok(
          error instanceof HintProbeIncompleteError,
          `expected HintProbeIncompleteError for ${String(exitCode)}`,
        );
        assert.equal(error.exitCode, exitCode);
        return true;
      },
    );
  }
});

void test('passes through the error of a hint probe whose exec rejects', async () => {
  const failure = new Error('Sandbox command timed out');
  const { sandbox } = hintAnswering(async () => {
    throw failure;
  });
  await assert.rejects(
    cwdRepoHint(sandbox, '/workspace/alpha'),
    (error: unknown) => {
      assert.equal(error, failure);
      assert.ok(!(error instanceof HintProbeIncompleteError));
      return true;
    },
  );
});

void test('reads every GitHub spelling of an origin URL', async () => {
  for (const origin of [
    'https://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'git@github.com:owner/repo.git',
    'https://github.com:8443/owner/repo.git',
  ]) {
    assert.equal(
      await cwdRepoHint(
        repositoryAt({ status: clean, origin }),
        '/workspace/alpha',
      ),
      'github',
      `expected github for ${origin}`,
    );
  }
});
