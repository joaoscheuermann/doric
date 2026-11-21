import type { Sandbox } from 'sandbox';

import type { CwdRepo } from '../../contracts/model.js';

/*
 * The repository hint of a working directory, moved from the provisional
 * `git-status.ts` (bundle isolation 7(c)). The Git summary went to the `git`
 * bundle; the hint stays with the runtime, which writes it on the Thread.
 */

/**
 * The cheap repository hint of one directory: is there a repository rooted right
 * here, and does it point at GitHub. Only a directory whose own root holds a
 * `.git` marker is asked for its `origin`, so the common case - a directory that
 * is no repository, or that lies inside one without holding it - costs one path
 * test. The marker is a directory for an ordinary clone and a file for a linked
 * worktree or a submodule, so both count.
 */
const HINT_SCRIPT = String.raw`cd -- "$1" 2>/dev/null || exit 0
[ -d .git ] || [ -f .git ] || exit 0
printf 'present\n'
git config --get remote.origin.url 2>/dev/null || true
`;

/** How long the hint probe may run. */
const HINT_TIMEOUT_MS = 5000;

/** The hint probe ran but did not finish: it exited non-zero, was killed or timed out. */
export class HintProbeIncompleteError extends Error {
  constructor(readonly exitCode: number | null) {
    super(`The repository hint probe exited with ${String(exitCode)}.`);
    this.name = 'HintProbeIncompleteError';
  }
}

/**
 * The repository hint of one working directory, or nothing when it holds none.
 * Rejects with HintProbeIncompleteError when the probe did not finish: the
 * script exits 0 on every path it completes, so any other exit code, `null`
 * included, is a failure. An exec that rejects passes its error through.
 */
export const cwdRepoHint = async (
  sandbox: Sandbox,
  cwd: string,
): Promise<CwdRepo | undefined> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', HINT_SCRIPT, 'git-hint', cwd],
    timeoutMs: HINT_TIMEOUT_MS,
  });

  if (result.exitCode !== 0)
    throw new HintProbeIncompleteError(result.exitCode);

  const [marker, ...origin] = result.stdout.split('\n');
  if (marker !== 'present') return undefined;

  return isGithub(origin.join('\n').trim()) ? 'github' : 'git';
};

/**
 * Whether an `origin` URL names github.com, in any of Git's three spellings:
 * `https://`, `ssh://`, and the scp-like `git@github.com:owner/repo.git` no URL
 * parser accepts. A path or another host is not GitHub, however alike it reads.
 */
const isGithub = (url: string): boolean =>
  hostOf(url)?.toLowerCase() === 'github.com';

const hostOf = (url: string): string | undefined => {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }

  const hostname = parsed?.hostname;
  if (hostname !== undefined && hostname !== '') return hostname;

  // `git@github.com:owner/repo.git` is not a URL any parser accepts.
  return /^(?:[^@/]+@)?([^:/]+):[^/]/u.exec(url)?.[1];
};
