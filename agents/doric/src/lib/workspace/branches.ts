import type { Sandbox } from 'sandbox';

import { physicallyInside } from './cwd.js';
import { threadGit } from './git-status.js';

export interface Branch {
  readonly name: string;
  readonly current: boolean;
  readonly commit: string;
  readonly subject: string;
  readonly worktree: string;
}
export interface Branches {
  readonly branches: readonly Branch[];
  readonly blocked?: string;
}
export type BranchResult =
  | { readonly status: 'ready'; readonly value: Branches }
  | { readonly status: 'missing' | 'inactive' }
  | { readonly status: 'refused'; readonly message: string };

/** Local branches only; remote fetching and branch creation are separate actions. */
export async function readBranches(
  sandbox: Sandbox,
  cwd: string,
): Promise<Branches> {
  if (!(await physicallyInside(sandbox, sandbox.root, cwd)))
    return {
      branches: [],
      blocked: 'The working directory must stay inside the workspace.',
    };
  const git = await threadGit(sandbox, cwd);
  if (!git.repo)
    return { branches: [], blocked: 'This directory is not a Git repository.' };
  if (!(await physicallyInside(sandbox, sandbox.root, git.root)))
    return {
      branches: [],
      blocked: 'The repository must stay inside the workspace.',
    };
  const result = await sandbox.exec({
    cmd: [
      'git',
      '-C',
      cwd,
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:strip=2)%00%(objectname:short)%00%(subject)%00%(worktreepath)%00',
      'refs/heads/',
    ],
  });
  if (result.exitCode !== 0) throw new Error('Could not read branches.');
  const fields = result.stdout.split('\0');
  const branches: Branch[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const name = fields[index].replace(/^\n/, '');
    branches.push({
      name,
      current: !git.detached && name === git.head,
      commit: fields[index + 1],
      subject: fields[index + 2],
      worktree: fields[index + 3],
    });
  }
  return {
    branches,
    ...(git.operation || git.conflicted
      ? {
          blocked:
            'Finish the current Git operation and resolve conflicts before switching branches.',
        }
      : {}),
  };
}

/** Switches an existing local branch without discarding changes or creating a stash. */
export async function switchBranch(
  sandbox: Sandbox,
  cwd: string,
  branch: string,
): Promise<BranchResult> {
  const value = await readBranches(sandbox, cwd);
  if (value.blocked) return { status: 'refused', message: value.blocked };
  const target = value.branches.find(({ name }) => name === branch);
  if (!target)
    return {
      status: 'refused',
      message: 'This local branch no longer exists.',
    };
  if (target.current) return { status: 'ready', value };
  if (target.worktree)
    return {
      status: 'refused',
      message: 'This branch is checked out in another worktree.',
    };
  const result = await sandbox.exec({
    cmd: ['git', '-C', cwd, 'switch', '--no-guess', '--', branch],
  });
  if (result.exitCode !== 0)
    return {
      status: 'refused',
      message:
        'Git could not switch branches. Commit or stash conflicting local changes and try again.',
    };
  return { status: 'ready', value: await readBranches(sandbox, cwd) };
}
