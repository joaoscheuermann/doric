import type { Sandbox } from 'sandbox';

import type { CwdRepo, GitOperation, ThreadGit } from './types.js';

/**
 * The whole Git summary in one sandbox round trip: the labeled facts below, then
 * the raw `git status --porcelain=v2 --branch` document as the tail. A VM command
 * is the expensive part, so the probe never spends one per field, and it never
 * runs `rev-list`: porcelain-v2's `# branch.ab` header already carries the ahead
 * and behind counts when an upstream exists.
 *
 * `$0` is the label a test fake recognizes the script by, as the workspace
 * listing scripts in `sandbox` are; `$1` is the working directory. Every fact is
 * one line of `key value`, and the status document follows the `status` marker,
 * so a fact can never be read out of porcelain output.
 */
const PROBE_SCRIPT = String.raw`dir=$1
cd -- "$dir" 2>/dev/null || { printf 'repo false\n'; exit 0; }
top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf 'repo false\n'; exit 0; }
printf 'repo true\n'
printf 'top %s\n' "$top"
printf 'gitdir %s\n' "$(git rev-parse --absolute-git-dir 2>/dev/null)"
printf 'commondir %s\n' "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
printf 'shallow %s\n' "$(git rev-parse --is-shallow-repository 2>/dev/null)"
git symbolic-ref -q HEAD >/dev/null 2>&1 || printf 'short %s\n' "$(git rev-parse --short HEAD 2>/dev/null)"
op=
for name in REBASE_HEAD CHERRY_PICK_HEAD REVERT_HEAD MERGE_HEAD BISECT_LOG; do
  if [ -e "$(git rev-parse --git-path "$name" 2>/dev/null)" ]; then op=$name; break; fi
done
if [ -z "$op" ]; then
  todo=$(git rev-parse --git-path sequencer/todo 2>/dev/null)
  if [ -f "$todo" ]; then
    verb=
    read -r verb _ < "$todo"
    if [ "$verb" = revert ]; then op=REVERT_HEAD; else op=CHERRY_PICK_HEAD; fi
  fi
fi
[ -n "$op" ] && printf 'operation %s\n' "$op"
printf 'stash %s\n' "$(git stash list 2>/dev/null | wc -l | tr -d ' ')"
if [ -f "$top/.gitmodules" ]; then
  printf 'submodules %s\n' "$(git submodule status --recursive 2>/dev/null | wc -l | tr -d ' ')"
fi
url=$(git config --get remote.origin.url 2>/dev/null) && printf 'origin %s\n' "$url"
printf 'status\n'
git --no-optional-locks status --porcelain=v2 --branch
`;

/** The marker each in-progress operation leaves behind, as the probe names it. */
const operations: Readonly<Record<string, GitOperation>> = {
  REBASE_HEAD: 'rebase',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REVERT_HEAD: 'revert',
  MERGE_HEAD: 'merge',
  BISECT_LOG: 'bisect',
};

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

const NOT_A_REPO: ThreadGit = { repo: false };

/** The Git summary of one working directory, answering `repo: false` when there is none. */
export const threadGit = async (
  sandbox: Sandbox,
  cwd: string,
): Promise<ThreadGit> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', PROBE_SCRIPT, 'git-probe', cwd],
  });

  if (result.exitCode !== 0) return NOT_A_REPO;

  const probe = probeDocument(result.stdout);
  if (probe?.facts.get('repo') !== 'true') return NOT_A_REPO;

  const head = statusOf(probe.status);
  const root = probe.facts.get('top');
  if (head === undefined || root === undefined) return NOT_A_REPO;

  const detached = head.branch === '(detached)';
  const short = probe.facts.get('short');

  return {
    repo: true,
    root,
    head: detached ? (short ?? head.oid) : head.branch,
    detached,
    unborn: head.oid === '(initial)',
    upstream: head.upstream ?? null,
    ahead: head.ahead,
    behind: head.behind,
    dirty: {
      staged: head.staged,
      modified: head.modified,
      untracked: head.untracked,
    },
    conflicted: head.conflicted,
    operation: operations[probe.facts.get('operation') ?? ''] ?? null,
    worktree: probe.facts.get('gitdir') !== probe.facts.get('commondir'),
    shallow: probe.facts.get('shallow') === 'true',
    stash: wholeCount(probe.facts.get('stash')),
    // Only a repository that declares submodules spends the recursive listing,
    // so the common repository pays nothing for a fact it would report as zero.
    submodules: wholeCount(probe.facts.get('submodules')),
  };
};

/** The repository hint of one working directory, or nothing when it holds none. */
export const cwdRepoHint = async (
  sandbox: Sandbox,
  cwd: string,
): Promise<CwdRepo | undefined> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', HINT_SCRIPT, 'git-hint', cwd],
  });

  if (result.exitCode !== 0) return undefined;

  const [marker, ...origin] = result.stdout.split('\n');
  if (marker !== 'present') return undefined;

  return isGithub(origin.join('\n').trim()) ? 'github' : 'git';
};

/**
 * One probe document, split into its labeled facts and the porcelain-v2 document
 * that follows the `status` marker. The facts precede the marker, so a status
 * record can never be read as a fact, and anything else is a malformed answer.
 */
const probeDocument = (
  stdout: string,
):
  | { readonly facts: ReadonlyMap<string, string>; readonly status: string }
  | undefined => {
  const lines = stdout.split('\n');
  const facts = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === 'status')
      return { facts, status: lines.slice(index + 1).join('\n') };
    const separator = line.indexOf(' ');
    if (separator === -1) return undefined;
    facts.set(line.slice(0, separator), line.slice(separator + 1));
  }

  return undefined;
};

/**
 * The porcelain-v2 headers and record counts. `# branch.oid` and `# branch.head`
 * are always present in a readable repository, so their absence means the status
 * document is not one. `# branch.ab` exists only with an upstream, which is
 * exactly when ahead and behind have a meaning; with none, both are zero.
 */
const statusOf = (
  status: string,
):
  | {
      readonly oid: string;
      readonly branch: string;
      readonly upstream?: string;
      readonly ahead: number;
      readonly behind: number;
      readonly staged: number;
      readonly modified: number;
      readonly untracked: number;
      readonly conflicted: number;
    }
  | undefined => {
  let oid: string | undefined;
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;

  for (const line of status.split('\n')) {
    if (line.startsWith('# ')) {
      const header = line.slice(2);
      const separator = header.indexOf(' ');
      const key = separator === -1 ? header : header.slice(0, separator);
      const value = separator === -1 ? '' : header.slice(separator + 1);

      if (key === 'branch.oid') oid = value;
      else if (key === 'branch.head') branch = value;
      else if (key === 'branch.upstream') upstream = value;
      else if (key === 'branch.ab') {
        const ab = /^\+(\d+) -(\d+)$/u.exec(value);
        if (ab !== null) {
          ahead = Number(ab[1]);
          behind = Number(ab[2]);
        }
      }
    } else if (line.startsWith('? ')) {
      untracked += 1;
    } else if (line.startsWith('u ')) {
      conflicted += 1;
    } else if (
      line.length >= 4 &&
      (line.startsWith('1 ') || line.startsWith('2 '))
    ) {
      // `1 <XY> ...` and `2 <XY> ...`: X is the index's status and Y the
      // working tree's, and `.` in either place means unchanged there.
      if (line.charAt(2) !== '.') staged += 1;
      if (line.charAt(3) !== '.') modified += 1;
    }
  }

  if (oid === undefined || branch === undefined) return undefined;

  return {
    oid,
    branch,
    ...(upstream === undefined ? {} : { upstream }),
    ahead,
    behind,
    staged,
    modified,
    untracked,
    conflicted,
  };
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

/** A probe count: a whole non-negative number, and zero for anything else. */
const wholeCount = (value: string | undefined): number => {
  const number = Number(value ?? '');
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};
