// Local branches of a Thread's directory and the branch switch (stage 10,
// §3.8), moved from the runtime's provisional `branches.ts`, with the
// physical-path check of `domain/cwd.ts` copied (a helper both sides need is
// copied, not imported across bundles).

import type { Sandbox } from 'sandbox';

import type { Branch, Branches, BranchSwitch } from '../contracts/index.js';
import { threadGit } from './status.js';

/**
 * The sandbox's own answer to "is this directory physically inside the root".
 * `pwd -P` prints the physical path, so a symbolic link that names a path inside
 * the workspace while resolving outside it is caught here; the root is resolved
 * the same way, because the mount a sandbox serves may itself be a link.
 */
const PHYSICAL_SCRIPT = String.raw`inside=$(cd -- "$2" 2>/dev/null && pwd -P) || { printf 'missing\n'; exit 0; }
root=$(cd -- "$1" 2>/dev/null && pwd -P) || { printf 'outside\n'; exit 0; }
case "$inside" in
  "$root"|"$root"/*) printf 'inside\n' ;;
  *) printf 'outside\n' ;;
esac
`;

/**
 * Whether one directory resolves inside the workspace root. The lexical check a
 * resolver makes cannot see a symbolic link, so a path that reads as inside the
 * workspace while pointing outside it is refused here, and every path a tool
 * derives from a working directory stays inside the workspace that directory
 * claims to be in.
 */
export const physicallyInside = async (
  sandbox: Sandbox,
  root: string,
  path: string,
): Promise<boolean> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', PHYSICAL_SCRIPT, 'cwd-physical', root, path],
  });

  return result.exitCode === 0 && result.stdout.trim() === 'inside';
};

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
): Promise<BranchSwitch> {
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
