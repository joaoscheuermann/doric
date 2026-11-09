// git.commands/v1@1.1.0 `discard` (ui-redesign §4.4 "Discard on the host"):
// the steps a Discard runs on the live Thread, under the Project mutation
// lock the service holds. Discard cannot be undone, so every guard runs before
// the first write, and the first that fails answers with nothing written:
// (1) a stale working directory, (2) a repository the Thread's read does not
// list, (3) running work in, under or above that repository, (4) a path with
// no listed change or naming another repository, (5) a conflict. Then (6) one
// Git command per target, and a new read decides what was discarded.

import { posix } from 'node:path';

import type { FileChange } from 'runtime/contracts';
import { type Sandbox, workspacePathKind } from 'sandbox';

import type { Discard } from '../contracts/index.js';
import { readProjectChanges, under } from './changes.js';

/** What one Discard asks for, with the Thread it runs on. */
export interface DiscardRequest {
  /** The Thread's working directory when the task started. */
  readonly threadCwd: string;
  /** The working directory the Changes view read with. */
  readonly cwd: string;
  /** The repository root relative to the sandbox root; `''` is the root. */
  readonly repository: string;
  /** Paths relative to the repository, as the Changes read lists them. */
  readonly paths?: readonly string[];
  /** The working directories with running work in the Project. */
  readonly busy: () => Promise<readonly string[]>;
}

/** The sentences a Discard answers with; the window shows them as they are. */
export const discardMessages = {
  staleCwd:
    'The working directory changed. Reopen the Changes view and try again.',
  notRepository: (repository: string) =>
    `${repository} is not a repository of this working directory.`,
  busy: 'Wait for active prompts and terminal commands in this repository to finish before discarding changes.',
  noChange: (path: string) => `${path} has no change to discard.`,
  separate: (path: string) =>
    `${path} is a separate repository. Discard does not change it.`,
  conflict: (path: string) =>
    `${path} has a merge conflict. Resolve it before discarding.`,
  stillChanged: (path: string) => `${path} still has changes after Discard.`,
} as const;

const refused = (message: string): Discard => ({ status: 'refused', message });

/**
 * A working directory relative to the sandbox root, as `files/contracts`'
 * `workspacePath` makes it against `/workspace`: the root is `''`, and a path
 * outside the root (or not absolute) reads as the root.
 */
const sandboxRelative = (root: string, cwd: string): string => {
  const base = root.replace(/\/+$/, '');
  const path = cwd.replace(/\/+$/, '');
  if (path === base) return '';
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : '';
};

/**
 * A busy directory, normalised first so that `..` cannot step it out of the
 * repository it writes into. Outside the sandbox, or not absolute, it reads as
 * the root, which holds every repository, so it blocks.
 */
const busyPath = (root: string, cwd: string): string =>
  posix.isAbsolute(cwd) ? sandboxRelative(root, posix.normalize(cwd)) : '';

/** `''` names the root; otherwise no NUL, no leading `/`, no `..` segment. */
const validRepository = (repository: string): boolean =>
  !repository.includes('\0') &&
  !repository.startsWith('/') &&
  !repository.split('/').includes('..');

/** A change Discard must not touch: a nested repository or a submodule. */
const separateRepository = async (
  sandbox: Sandbox,
  repository: string,
  path: string,
): Promise<boolean> =>
  (await workspacePathKind(sandbox, posix.join(repository, path, '.git'))) !==
  'missing';

/** The changes the read lists for `repository` in the Thread's scope. */
const listedChanges = async (
  sandbox: Sandbox,
  scope: string,
  repository: string,
): Promise<readonly FileChange[] | undefined> =>
  (await readProjectChanges(sandbox, scope)).find(
    (listed) => listed.path === repository,
  )?.changes;

/** Step 4: every listed change but other repositories, or exactly `paths`. */
const targetsOf = async (
  sandbox: Sandbox,
  repository: string,
  changes: readonly FileChange[],
  paths: readonly string[] | undefined,
): Promise<readonly FileChange[] | string> => {
  if (paths === undefined) {
    const own = await Promise.all(
      changes.map(
        async (change) =>
          !(await separateRepository(sandbox, repository, change.path)),
      ),
    );
    return changes.filter((_, index) => own[index]);
  }
  const targets: FileChange[] = [];
  for (const path of new Set(paths)) {
    const change = changes.find((listed) => listed.path === path);
    if (change === undefined) return discardMessages.noChange(path);
    if (await separateRepository(sandbox, repository, path))
      return discardMessages.separate(path);
    targets.push(change);
  }
  return targets;
};

/**
 * The Git arguments that discard one change, chosen by its two status letters
 * (its `status` reads `AD` as deleted and a copy as renamed). `clean` without
 * `-x` never removes an ignored file. `restore` from `HEAD` removes a path
 * `HEAD` lacks, so it also discards `A`, `AM` and `AD`; a rename restores its
 * origin too. A copy's origin is left alone: Git reports a copy only when the
 * origin changed in the same change set, and that change is not the copy's.
 * Without `HEAD`, every staged path is new and leaves through `rm --force`.
 */
const discardArgs = (change: FileChange, head: boolean): string[] => {
  const code = `${change.indexStatus}${change.worktreeStatus}`;
  if (code === '??') return ['clean', '--force', '--quiet', '--', change.path];
  if (!head && change.indexStatus === 'A')
    return ['rm', '--force', '--quiet', '--', change.path];
  const origin =
    code.includes('R') && change.originalPath !== undefined
      ? [change.originalPath]
      : [];
  return [
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    change.path,
    ...origin,
  ];
};

const firstLine = (text: string): string | undefined =>
  text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

/** Step 6: one command per target; the first failure stops the loop. */
const runDiscard = async (
  sandbox: Sandbox,
  repository: string,
  targets: readonly FileChange[],
): Promise<string | undefined> => {
  // Literal pathspecs: a name such as `*.log` or `:!x` names that file only.
  const git = (...args: string[]) =>
    sandbox.exec({
      cmd: [
        'git',
        '--literal-pathspecs',
        '-C',
        repository === '' ? sandbox.root : repository,
        ...args,
      ],
    });
  const head = (await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode;
  for (const target of targets) {
    const result = await git(...discardArgs(target, head === 0));
    if (result.exitCode !== 0)
      return (
        firstLine(result.stderr) ??
        `git exited with ${result.exitCode} discarding ${target.path}.`
      );
  }
  return undefined;
};

/** Steps 1–6 of a Discard on the Thread's sandbox. */
export const discardChanges = async (
  sandbox: Sandbox,
  request: DiscardRequest,
): Promise<Discard> => {
  const { repository } = request;
  if (request.cwd !== request.threadCwd)
    return refused(discardMessages.staleCwd);

  // The scope the Changes view reads with.
  const scope = sandboxRelative(sandbox.root, request.threadCwd);
  const changes = validRepository(repository)
    ? await listedChanges(sandbox, scope, repository)
    : undefined;
  if (changes === undefined)
    return refused(discardMessages.notRepository(repository));

  const busy = (await request.busy()).map((cwd) => busyPath(sandbox.root, cwd));
  if (busy.some((cwd) => under(cwd, repository) || under(repository, cwd)))
    return refused(discardMessages.busy);

  const targets = await targetsOf(sandbox, repository, changes, request.paths);
  if (typeof targets === 'string') return refused(targets);

  const conflicted = targets.find((change) => change.status === 'conflicted');
  if (conflicted !== undefined)
    return refused(discardMessages.conflict(conflicted.path));

  const failure = await runDiscard(sandbox, repository, targets);
  const remaining = new Set(
    (await listedChanges(sandbox, scope, repository))?.map(
      (change) => change.path,
    ),
  );
  const discarded = targets
    .filter((target) => !remaining.has(target.path))
    .map((target) => target.path);
  if (failure !== undefined)
    return { status: 'failed', message: failure, discarded };
  const left = targets.find((target) => remaining.has(target.path));
  if (left !== undefined)
    return {
      status: 'failed',
      message: discardMessages.stillChanged(left.path),
      discarded,
    };
  return { status: 'ready', value: { discarded } };
};
