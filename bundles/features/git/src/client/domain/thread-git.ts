/**
 * The git summary the host serves for one Thread's working directory, and the
 * rules that turn it into the footer's line. The host decides all of it from the
 * disk alone; this module only decides how the answer reads.
 */
export type GitOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

export type GitBranches = {
  readonly status?: 'pending' | 'unavailable';
  readonly branches: readonly {
    readonly name: string;
    readonly current: boolean;
    readonly commit: string;
    readonly subject: string;
    readonly worktree: string;
  }[];
  readonly blocked?: string;
};
export type ThreadGit =
  | { readonly repo: false; readonly status?: 'pending' | 'unavailable' }
  | {
      readonly repo: true;
      /** The sandbox-absolute root of the repository the cwd sits in. */
      readonly root: string;
      /** The branch name, or the short sha when detached. */
      readonly head: string;
      readonly detached: boolean;
      readonly unborn: boolean;
      readonly upstream: string | null;
      readonly ahead: number;
      readonly behind: number;
      readonly dirty: {
        readonly staged: number;
        readonly modified: number;
        readonly untracked: number;
      };
      readonly conflicted: number;
      readonly operation: GitOperation | null;
      readonly worktree: boolean;
      readonly shallow: boolean;
      readonly stash: number;
      /** How many submodules the repository declares, at any depth. */
      readonly submodules: number;
    };

/** What the git line calls a repository that is one. */
export type Repository = Extract<ThreadGit, { readonly repo: true }>;

const OPERATION_LABEL: Record<GitOperation, string> = {
  merge: 'MERGE',
  rebase: 'REBASE',
  'cherry-pick': 'CHERRY-PICK',
  revert: 'REVERT',
  bisect: 'BISECT',
};

/** The branch the summary is on: its name, a detached sha, or an unborn name. */
const branchIdentity = (git: Repository): string => {
  if (git.unborn) return `${git.head} · initial`;
  if (git.detached) return `DETACHED @${git.head}`;
  return git.head;
};

/** How far the branch is from its upstream, naming only the counts that are not
 * zero: an up-to-date branch has nothing to say, and neither has one that tracks
 * nothing. */
const tracking = (git: Repository): string | undefined => {
  if (git.upstream === null) return undefined;
  const parts: string[] = [];
  if (git.ahead > 0) parts.push(`↑${git.ahead}`);
  if (git.behind > 0) parts.push(`↓${git.behind}`);
  return parts.length === 0 ? undefined : parts.join(' ');
};

/** The one dirty sign: staged, modified and untracked counts, each named only
 * when it is not zero. */
const dirty = (git: Repository): string | undefined => {
  const parts: string[] = [];
  if (git.dirty.staged > 0) parts.push(`+${git.dirty.staged}`);
  if (git.dirty.modified > 0) parts.push(`!${git.dirty.modified}`);
  if (git.dirty.untracked > 0) parts.push(`?${git.dirty.untracked}`);
  return parts.length === 0 ? undefined : parts.join(' ');
};

/** A conflict is never hidden: it is the highest-priority fact about a tree. */
const conflict = (git: Repository): string | undefined =>
  git.conflicted > 0 ? `CONFLICT·${git.conflicted}` : undefined;

/** An operation in progress is never hidden either. */
const operation = (git: Repository): string | undefined =>
  git.operation === null ? undefined : OPERATION_LABEL[git.operation];

/**
 * The footer's always-visible git line: the branch identity, then the tracking
 * counts, the dirty sign, and finally a conflict or operation marker — those two
 * never hidden, however much else there is. A cwd that is no repository reads as
 * nothing, because the path alone says what it is.
 */
export const gitLine = (git: ThreadGit): string => {
  if (!git.repo) return '';
  return [
    branchIdentity(git),
    tracking(git),
    dirty(git),
    conflict(git),
    operation(git),
  ]
    .filter((segment): segment is string => segment !== undefined)
    .join(' · ');
};

/** Status beneath the branch picker, without repeating the branch name. */
export const gitStatusLine = (git: Repository): string =>
  [tracking(git), dirty(git), conflict(git), operation(git)]
    .filter((value): value is string => value !== undefined)
    .join(' · ') || 'Working tree clean';

/**
 * The glyph a git line leads with: the repository's, whenever the summary says
 * the working directory works in one — a directory inside a repository is still
 * working in it, even though its own root holds no marker — and GitHub's only
 * when the host's hint says the remote is GitHub. A directory that is no
 * repository leads with the conversation's own icon, like the Thread row.
 */
export const gitBadgeKind = (
  git: ThreadGit | undefined,
  hint: string | undefined,
): 'conversation' | 'git' | 'github' =>
  git?.repo === true ? (hint === 'github' ? 'github' : 'git') : 'conversation';

/** One labelled fact the details popover states. */
export type GitDetail = {
  readonly label: string;
  readonly value: string;
};

/**
 * The repository's slower facts, for the popover behind the git line: the branch
 * it is on, the full upstream it tracks, its dirty breakdown and conflict count,
 * its stash, and whether it is a shallow clone or a linked worktree. A shallow
 * clone and a linked worktree are named only when true, because their absence is
 * the ordinary case and says nothing worth a row.
 */
export const gitDetails = (git: ThreadGit): readonly GitDetail[] => {
  if (!git.repo) return [];
  const details: GitDetail[] = [
    { label: 'Branch', value: branchIdentity(git) },
    { label: 'Upstream', value: git.upstream ?? 'none' },
    { label: 'Root', value: git.root },
    {
      label: 'Changes',
      value: `+${git.dirty.staged} !${git.dirty.modified} ?${git.dirty.untracked}`,
    },
    { label: 'Conflicts', value: `${git.conflicted}` },
    { label: 'Stashes', value: `${git.stash}` },
  ];
  if (git.shallow) details.push({ label: 'Clone', value: 'shallow' });
  if (git.worktree)
    details.push({ label: 'Checkout', value: 'linked worktree' });
  if (git.submodules > 0)
    details.push({ label: 'Submodules', value: `${git.submodules}` });
  if (git.operation !== null) {
    details.push({ label: 'Operation', value: OPERATION_LABEL[git.operation] });
  }
  return details;
};
