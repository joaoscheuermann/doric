import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';

import type { Sandbox } from 'sandbox';

import { readBranches, switchBranch } from '../src/lib/workspace/branches.js';
import { fakeSandbox } from './helpers/workspace.js';

const run = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doric-branches-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox: Sandbox = {
    ...fakeSandbox(),
    root,
    exec: async ({ cmd, cwd }) => {
      try {
        const value = await run(cmd[0], cmd.slice(1), { cwd: cwd ?? root });
        return {
          ...value,
          exitCode: 0,
          stdoutBytes: Buffer.from(value.stdout),
          stderrBytes: Buffer.from(value.stderr),
        };
      } catch (error) {
        const value = error as { stdout: string; stderr: string; code: number };
        return {
          stdout: value.stdout,
          stderr: value.stderr,
          exitCode: value.code,
          stdoutBytes: Buffer.from(value.stdout),
          stderrBytes: Buffer.from(value.stderr),
        };
      }
    },
  };
  const git = (...args: string[]) => run('git', ['-C', root, ...args]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(join(root, 'file'), 'initial\n');
  await git('add', '.');
  await git('commit', '-qm', 'Initial commit');
  return { root, sandbox, git };
}

void test('lists local branches with commit details and switches while preserving unrelated changes', async (t) => {
  const f = await fixture(t);
  await f.git('branch', 'feature');
  await writeFile(join(f.root, 'new'), 'keep me');
  const before = await readBranches(f.sandbox, f.root);
  assert.equal(before.branches.find((branch) => branch.current)?.name, 'main');
  assert.equal(
    before.branches.find((branch) => branch.name === 'feature')?.subject,
    'Initial commit',
  );
  const result = await switchBranch(f.sandbox, f.root, 'feature');
  assert.equal(result.status, 'ready');
  assert.equal(
    (await f.git('branch', '--show-current')).stdout.trim(),
    'feature',
  );
  assert.equal(await readFile(join(f.root, 'new'), 'utf8'), 'keep me');
});

void test('refuses a branch used by another worktree and does not change the current branch', async (t) => {
  const f = await fixture(t);
  await f.git('worktree', 'add', '-qb', 'linked', join(f.root, 'linked'));
  const branches = await readBranches(f.sandbox, f.root);
  assert.equal(
    branches.branches.find((branch) => branch.name === 'linked')?.worktree,
    join(f.root, 'linked'),
  );
  assert.equal(
    (await switchBranch(f.sandbox, f.root, 'linked')).status,
    'refused',
  );
  assert.equal((await f.git('branch', '--show-current')).stdout.trim(), 'main');
});

void test('refuses a checkout that would overwrite local content without creating a stash', async (t) => {
  const f = await fixture(t);
  await f.git('switch', '-qc', 'feature');
  await writeFile(join(f.root, 'file'), 'feature\n');
  await f.git('commit', '-qam', 'Feature');
  await f.git('switch', '-q', 'main');
  await writeFile(join(f.root, 'file'), 'local edits\n');
  assert.equal(
    (await switchBranch(f.sandbox, f.root, 'feature')).status,
    'refused',
  );
  assert.equal(await readFile(join(f.root, 'file'), 'utf8'), 'local edits\n');
  assert.equal((await f.git('stash', 'list')).stdout, '');
  assert.equal((await f.git('branch', '--show-current')).stdout.trim(), 'main');
});

void test('rejects unknown branch expressions and reports directories without a repository', async (t) => {
  const f = await fixture(t);
  for (const name of ['HEAD~1', '--discard-changes', 'main; touch injected'])
    assert.equal(
      (await switchBranch(f.sandbox, f.root, name)).status,
      'refused',
    );
  assert.deepEqual((await readBranches(f.sandbox, tmpdir())).branches, []);
});
