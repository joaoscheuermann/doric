# git

`git` is the feature bundle that lets the Doric agent run Git inside its
Project's sandbox and lets the reader follow that work in the desktop window.
It gives the agent the `git` tool and six Git skills, and it gives the window
the Changes view, the comparison tab, the working directory and branch picker
of the Files column's footer, the marks of changed paths in the Files tree,
the Discard action and the Versioning settings section.

This README is the bundle's complete overview. The flow across bundles is in
the feature doc [Git](../../../docs/features/git.md); the rules for changing
the bundle are in [`AGENTS.md`](AGENTS.md).

## Manifest

[`manifest.json`](manifest.json) declares:

- `id`: `git`; `version`: `1.4.0`; `engines.doric`: `^1.0.0`; `description`:
  "Git repository management capabilities for the Doric agent."
- `provides`:

  | Contract                 | Version | Part                       | Provided by                                                  |
  | ------------------------ | ------- | -------------------------- | ------------------------------------------------------------ |
  | `git.commands/v1`        | 1.1.0   | host                       | [`src/host/service.ts`](src/host/service.ts)                 |
  | `git.changes/v1`         | 1.0.0   | client                     | [`src/client/changes/store.ts`](src/client/changes/store.ts) |
  | `git.open-comparison/v1` | 1.0.0   | client (command)           | [`src/client/commands.ts`](src/client/commands.ts)           |
  | `files.decorations/v1`   | 1.0.0   | client, cardinality `many` | [`src/client/changes/store.ts`](src/client/changes/store.ts) |

- `requires`, and what the bundle uses each for:

  | Contract                        | Part         | Use                                                                                                                                                                                                                 |
  | ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `tools/v1@^1.5.0`               | host         | registers the `git` tool ([`src/host/index.ts`](src/host/index.ts))                                                                                                                                                 |
  | `skills/v1@^1.3.0`              | host         | the host SDK registers the bundle's skills (see [Skills](#skills))                                                                                                                                                  |
  | `runtime.workspace/v1@^1.3.0`   | host         | the tool's working directory, and every Thread read of `git.commands/v1` through `withThread` ([`src/host/sandbox.ts`](src/host/sandbox.ts), [`src/host/service.ts`](src/host/service.ts))                          |
  | `runtime.lease/v1@^1.4.0`       | host         | the tool's sandbox, and every Project read of `git.commands/v1` through `withLease` ([`src/host/sandbox.ts`](src/host/sandbox.ts), [`src/host/service.ts`](src/host/service.ts))                                    |
  | `secrets/v1@^1.3.0`             | host, client | registers the `GIT` credential kind; lists the stored credentials for the Versioning section ([`src/host/index.ts`](src/host/index.ts), [`src/client/settings/versioning.tsx`](src/client/settings/versioning.tsx)) |
  | `ui/v1@^1.0.0`                  | client       | defines the six elements ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                             |
  | `regions/v1@^1.0.0`             | client       | adds the three region items ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                          |
  | `navigation/v1@^1.0.0`          | client       | registers the route `/settings/git` ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                  |
  | `commands/v1@^1.0.0`            | client       | registers `git.open-comparison/v1`; runs it and `files.open-file/v1` ([`src/client/commands.ts`](src/client/commands.ts))                                                                                           |
  | `workspace.selection/v1@^1.0.0` | client       | the selected Project and Thread ids ([`src/client/hooks/use-selection.ts`](src/client/hooks/use-selection.ts))                                                                                                      |
  | `runtime.records/v1@^1.0.0`     | client       | the selected Project's and Thread's records ([`src/client/hooks/use-selection.ts`](src/client/hooks/use-selection.ts))                                                                                              |
  | `layout.tabs/v2@^2.0.0`         | client       | opens the comparison tab with its `menu`; reads the current tab ([`src/client/commands.ts`](src/client/commands.ts), [`src/client/changes/git-changes.tsx`](src/client/changes/git-changes.tsx))                    |
  | `settings.config/v1@^1.0.0`     | client       | reads and edits the settings window's draft ([`src/client/settings/versioning.tsx`](src/client/settings/versioning.tsx))                                                                                            |
  | `hooks/v1@^1.0.0`               | client       | waits for `chat.hooks/v2` ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                            |

- `optional`, and what happens without each:

  | Contract             | Part   | Use                                                                                  | Without it                                                         |
  | -------------------- | ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
  | `terminal/v1`        | host   | the Project's terminal sessions, for the busy check of a branch switch and a Discard | only Threads with a running or queued prompt count as running work |
  | `files.sandbox/v1`   | client | the Files tree read the Changes view waits on before it draws                        | the Changes view draws from the changes read alone                 |
  | `files.refresh/v1`   | client | the window's refresh coordinator of a Project's reads                                | a refresh rereads only this bundle's queries                       |
  | `files.open-file/v1` | client | "Open file" in the comparison tab and its menu                                       | the command call fails and is ignored                              |
  | `chat.hooks/v2`      | client | `onThreadUpdateHook`, to refresh after a `git` call                                  | no refresh follows a `git` call                                    |

- `desktopScope`: a window may send `projectId`, `threadId` and `promptId` to
  `git.commands/v1`.

[`package.json`](package.json) exports `./contracts` (the contracts module) and
`./contracts/gen/*`, the protobuf-es code the target `generate-proto` writes
into `src/contracts/gen/` (ignored by Git) from
[`proto/doric/git/`](proto/doric/git): `commands/v1`, `changes/v1` and
`open_comparison/v1`, the target shape of its contracts. That code imports
`@bufbuild/protobuf`, a dependency.
At run time the host part imports `sandbox` (`listSandboxRepos`,
`workspacePathKind`), `tool` (`defineTool`), `runtime/contracts` and
`terminal/contracts`; the client part imports the values
`filesDecorationsMethods`, `ROOT_PATH`, `workspacePath` and `sandboxNotice`
from `files/contracts`, which makes `files` one of its `dependencies`, and
takes every other `files.*` type with `import type`.

## Parts

- **Contracts module** ([`src/contracts/index.ts`](src/contracts/index.ts),
  [`src/contracts/reads.ts`](src/contracts/reads.ts)): the types, method
  schemas and refs of `git.commands/v1` and `git.changes/v1`, the id and input
  schema of `git.open-comparison/v1`, and the changed-file types the window
  reads. It writes its own schemas instead of importing the runtime's, because
  the client part loads it too. `git/contracts` exports:
  - refs and method specs: `GitCommandsV1`, `gitMethods`, `GitChangesV1`,
    `gitChangesMethods`; the command id `OPEN_COMPARISON_COMMAND`
    (`'git.open-comparison/v1'`) with `openComparisonInput` and its type
    `OpenComparisonInput`;
  - the types of [`git.commands/v1`](#gitcommandsv1) and
    [`git.changes/v1`](#gitchangesv1) (`Git`, `GitChanges`, `ChangesScope`,
    `ChangesObservation`, `LeaseOutcome` re-exported from `runtime/contracts`,
    and the others shown there);
  - the window's changed-file types: `ProjectChange` (as `FileChange` with
    `staged`, `unstaged`, `indexStatus` and `worktreeStatus` optional),
    `ProjectFileChange`, `ProjectChanges`, `ProjectFileDiff`, `ChangeMark`,
    and the client adapter's answers
    `ProjectChangesResult = { status: 'ready'; changes: ProjectChanges } | { status: ProjectLeaseState; retryAfterSeconds?: number } | { status: 'invalid_path' | 'not_found' }`
    and `ProjectFileDiffResult`, the same with `{ status: 'ready'; diff: ProjectFileDiff }`,
    where `ProjectLeaseState` is `files`' `'missing' | 'pending' | 'expired' | 'unavailable'`.

  Other bundles import `gitMethods` too: the transport's test host builds a
  fake `git.commands/v1` from it
  ([`bundles/foundation/transport/tests/support/host.ts`](../../foundation/transport/tests/support/host.ts)).

- **Host part** ([`src/host/index.ts`](src/host/index.ts)): at activation it
  registers the `GIT` credential kind with `secrets/v1`, follows
  `terminal/v1` while some bundle provides it, provides `git.commands/v1`, and
  registers the `git` tool with `tools/v1` (`alwaysAvailable: false`,
  `order: 900`, so the tool is routable and not always offered).
- **Client part** ([`src/client/index.ts`](src/client/index.ts)): at
  activation it creates the window's one git store, provides
  `git.changes/v1` and `files.decorations/v1`, defines the six elements,
  registers `git.open-comparison/v1`, adds the region items and the
  `/settings/git` route, and registers the refresh after a `git` call. Every
  piece is bound to the activation's services, never to an element's, and the
  returned cleanup disposes each piece in reverse order and clears the store.
- **Skills** (`src/skills/<name>/SKILL.md`): six skills the build validates
  and the host loads (see [Skills](#skills)).

## The `git` tool

[`src/host/tools/git.ts`](src/host/tools/git.ts) defines the tool `git`. It
runs one Git command in the calling prompt's leased sandbox
([`src/host/sandbox.ts`](src/host/sandbox.ts)), with no shell.

Input (strict object):

| Field               | Type                                            | Meaning                                                                                                      |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `args`              | 1 to 128 strings, each at most 8,192 characters | the arguments after `git`                                                                                    |
| `working_directory` | string, optional                                | absolute, or relative to the Thread's working directory; empty or blank means the Thread's working directory |
| `timeout_ms`        | non-negative integer, optional                  | default 120,000; values above 600,000 run with 600,000                                                       |

Output (strict object, `schema: 'git.command.v1'`):

| Field               | Type                                        | Meaning                                                               |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| `working_directory` | string                                      | the directory the command ran in                                      |
| `exit_code`         | integer                                     | Git's exit code; `-1` when it has none or the command could not start |
| `duration_ms`       | non-negative integer                        | wall time of the call                                                 |
| `success`           | boolean                                     | `exit_code === 0`                                                     |
| `stdout`, `stderr`  | `{ bytes, text, truncated, omitted_bytes }` | the captured stream                                                   |

Behavior:

- The working directory is resolved and normalized against the Thread's
  working directory from `runtime.workspace/v1.cwd`. It must be the sandbox
  root or lie under it, checked lexically; otherwise the command does not run.
- The command runs as `git <args>` through `runtime.lease/v1.exec` with the
  environment `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`,
  `GIT_SEQUENCE_EDITOR=true` and `GCM_INTERACTIVE=Never`, so it never waits on
  a prompt or an editor. The tool does not pass an abort signal to the sandbox.
- A stream of at most 24,000 bytes is returned whole. A longer stream keeps
  its first and last 12,000 bytes, joined by `[<n> bytes omitted]` on its own
  line, with `truncated: true` and `omitted_bytes: <n>`.
- A failing `runtime.workspace/v1.cwd` or `runtime.lease/v1.describe` is
  thrown, and the tool call fails.
- A refused working directory or a failed `exec` is not thrown: the output
  has `exit_code: -1`, `success: false` and the stderr
  `Failed to execute Git in sandbox: <message>`, for example
  `Git working directory must stay under <root>.`
- Credentials never travel in the arguments; the sandbox's Git configuration
  supplies them. The tool's description tells the model to move the Thread's
  working directory into a repository it cloned, with the `cwd` tool.

## Skills

Each skill's frontmatter has `name`, `description`, `allowed-tools: [git]` and
an `order` that sets its global position in the system prompt;
the host SDK registers them from the bundle's own process after `activate` (`registerBundleSkills`, [packages/bundle/src/sdk/host/skills.ts](../../../packages/bundle/src/sdk/host/skills.ts)), reading them through `context.assets`, so `host.assets` lists `src/skills/*/SKILL.md`; a skill that cannot be registered is skipped and logged (`skill not registered`). `allowed-tools` is a run-time reference for the model: `skills/v1` 1.3.0 stores it as given and does not check it against `tools/v1`.

| Skill                                                                          | `order` | Use                                                                              |
| ------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------- |
| [`git-cloning`](src/skills/git-cloning/SKILL.md)                               | 2100    | clone a repository into a chosen sandbox location and verify what is checked out |
| [`git-commit-preparation`](src/skills/git-commit-preparation/SKILL.md)         | 2200    | review, stage, validate and commit a focused change                              |
| [`git-conflict-resolution`](src/skills/git-conflict-resolution/SKILL.md)       | 2300    | resolve merge, rebase, cherry-pick or revert conflicts                           |
| [`git-rebase`](src/skills/git-rebase/SKILL.md)                                 | 2400    | rebase a branch onto an explicit base                                            |
| [`git-remote-synchronization`](src/skills/git-remote-synchronization/SKILL.md) | 2500    | fetch and push with upstream, divergence and force checks                        |
| [`git-worktrees`](src/skills/git-worktrees/SKILL.md)                           | 2600    | create, inspect, move and remove linked worktrees                                |

## The `GIT` credential kind

[`src/host/credentials.ts`](src/host/credentials.ts) defines the kind the
host registers with `secrets/v1` at activation, before any start step reads a
credential: `id: 'GIT'`, `label: 'Git identity'`,
`required: ['username', 'email']`, `optional: []`. It carries an identity and no secret. The
[Credentials](../../../docs/features/credentials.md) feature doc describes
how the stored identity reaches the sandbox.

## `git.commands/v1`

`GitCommandsV1 = ref<Git>('git.commands/v1')`, version 1.1.0, provided by the
host part ([`src/contracts/index.ts`](src/contracts/index.ts),
[`src/host/service.ts`](src/host/service.ts)). Every method is exposed to the
desktop. `status` and `branches` take the Thread id as a string; every other
input is a strict object (an unknown field is refused). Outputs are loose
objects (an extra field is accepted), except the `ready` value of `discard`,
`{ discarded }`, which is strict.

### Types

```ts
type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';

type ThreadGit =
  | { repo: false }
  | {
      repo: true;
      root: string; // sandbox-absolute repository root
      head: string; // branch name, or the short sha when detached
      detached: boolean;
      unborn: boolean; // the branch has no commit yet
      upstream: string | null;
      ahead: number;
      behind: number;
      dirty: { staged: number; modified: number; untracked: number };
      conflicted: number;
      operation: GitOperation | null;
      worktree: boolean; // a linked worktree
      shallow: boolean;
      stash: number;
      submodules: number; // at any depth
    };

interface Branch {
  name: string;
  current: boolean;
  commit: string;
  subject: string;
  worktree: string;
}
interface Branches {
  branches: Branch[];
  blocked?: string;
}

type ThreadOutcome<T> =
  | { status: 'ready'; value: T }
  | { status: 'missing' | 'inactive' | 'pending' };
// missing: no record; inactive: no runtime, closing or terminal; pending: no lease

type BranchSwitch =
  | ThreadOutcome<Branches>
  | { status: 'refused'; message: string };

type Discard =
  | ThreadOutcome<{ discarded: string[] }>
  | { status: 'refused'; message: string } // nothing was written
  | { status: 'failed'; message: string; discarded: string[] };

// from runtime/contracts
type LeaseOutcome<T> =
  | { status: 'ready'; value: T }
  | { status: 'pending' | 'unavailable' | 'expired' | 'missing' };

type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

interface FileChange {
  // ProjectFileChange
  path: string; // relative to the repository
  originalPath?: string; // a rename's or copy's origin
  status: ProjectChangeStatus;
  staged: boolean;
  unstaged: boolean;
  indexStatus: string; // porcelain X letter
  worktreeStatus: string; // porcelain Y letter
}
interface RepositoryChanges {
  path: string;
  changes: FileChange[];
  added: number;
  removed: number;
}
interface ChangeSetEntry {
  path: string;
  status: Exclude<ProjectChangeStatus, 'conflicted'>;
}
interface ProjectChangeSet {
  path: string;
  diff: string;
  changes: ChangeSetEntry[];
}
interface FileDiff extends FileChange {
  repository: string;
  original: string;
  modified: string;
  binary: boolean;
  truncated: boolean;
}

type ChangesRead =
  | { status: 'read'; path?: string; repositories: RepositoryChanges[] }
  | { status: 'not_found' | 'invalid_path' };
type DiffRead =
  | { status: 'read'; path?: string; repositories: ProjectChangeSet[] }
  | { status: 'not_found' | 'invalid_path' };
type FileDiffRead =
  | { status: 'read'; diff: FileDiff }
  | { status: 'not_found' | 'invalid_path' };
```

A repository `path` is relative to the sandbox root, `''` for the root itself.

### Methods

| Method         | Input                                                                    | Output                       | Runs on                                                                           |
| -------------- | ------------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------- |
| `status`       | `threadId`                                                               | `ThreadOutcome<ThreadGit>`   | the live Thread, without the Project lock; refreshes the Thread's repository hint |
| `branches`     | `threadId`                                                               | `ThreadOutcome<Branches>`    | the live Thread, under the Project lock                                           |
| `switchBranch` | `{ threadId, branch, cwd }`                                              | `BranchSwitch`               | the live Thread, under the Project lock                                           |
| `discard`      | `{ threadId, cwd, repository, paths? }` (`paths` non-empty when present) | `Discard`                    | the live Thread, under the Project lock                                           |
| `changes`      | `{ path? }`                                                              | `LeaseOutcome<ChangesRead>`  | the Project's current lease (`call.scope.projectId`)                              |
| `diff`         | `{ path? }`                                                              | `LeaseOutcome<DiffRead>`     | the Project's current lease                                                       |
| `fileDiff`     | `{ repository, path }`                                                   | `LeaseOutcome<FileDiffRead>` | the Project's current lease                                                       |

Thread methods call `runtime.workspace/v1.withThread`; the lock is its
`exclusive: true`, which keeps a new prompt from starting while the method
runs. Project methods call `runtime.lease/v1.withLease`. No method acquires a
lease, and every Thread or lease state is an answer. A Git command that fails
where no answer is defined throws, and the caller receives a contract error.
The host's REST routes call these methods: `GET /projects/:id/changes`,
`GET /projects/:id/diff` and `GET /projects/:id/files/diff` the Project
methods
([`routes/projects.ts`](../../foundation/transport/src/host/routes/projects.ts)),
and `GET /threads/:id/git`, `GET /threads/:id/branches` and
`POST /threads/:id/branches` the Thread methods `status`, `branches` and
`switchBranch`
([`routes/threads.ts`](../../foundation/transport/src/host/routes/threads.ts)).

### `status`

[`src/host/status.ts`](src/host/status.ts) reads the whole summary in one
sandbox command: a shell probe that prints labeled facts, then
`git --no-optional-locks status --porcelain=v2 --branch`.

- A directory that cannot be entered, is not in a repository, or answers a
  malformed probe is `{ repo: false }`.
- `root` is `git rev-parse --show-toplevel`. `head` is `# branch.head`, or
  the short sha when it is `(detached)`; `unborn` is `# branch.oid` equal to
  `(initial)`. `ahead` and `behind` come from `# branch.ab` and are 0 without
  an upstream.
- `dirty.staged` counts records `1`/`2` whose index letter is not `.`,
  `dirty.modified` those whose worktree letter is not `.`, `untracked` the `?`
  records and `conflicted` the `u` records.
- `operation` is the first of `REBASE_HEAD`, `CHERRY_PICK_HEAD`,
  `REVERT_HEAD`, `MERGE_HEAD` and `BISECT_LOG` present in the Git directory;
  without one, a `sequencer/todo` whose first verb is `revert` is `revert` and
  any other is `cherry-pick`.
- `worktree` is true when the Git directory differs from the common
  directory; `shallow` is `git rev-parse --is-shallow-repository`; `stash` is
  the line count of `git stash list`; `submodules` counts
  `git submodule status --recursive` only when `.gitmodules` exists at the
  root, and is 0 otherwise. A count that is not a whole number reads as 0.

### `branches` and `switchBranch`

[`src/host/branches.ts`](src/host/branches.ts) and
[`src/host/service.ts`](src/host/service.ts).

- `branches` lists `refs/heads/` with `git for-each-ref`, newest committer
  date first: `name`, short `commit`, `subject` and `worktree` (the path of
  the worktree that has the branch checked out, `''` when none). `current` is
  true for the branch `status` names when HEAD is not detached.
- `blocked` holds the first sentence that applies, and the list is then
  empty for the first three:
  - `The working directory must stay inside the workspace.` (the directory
    cannot be entered, or its physical path, `pwd -P`, is outside the
    physical sandbox root);
  - `This directory is not a Git repository.`;
  - `The repository must stay inside the workspace.`;
  - an operation or a conflict in progress:
    `Finish the current Git operation and resolve conflicts before switching branches.`;
  - running work (below), which replaces any other sentence:
    `Wait for active prompts and terminal commands in this worktree to finish before switching branches.`
- A failing `for-each-ref` throws `Could not read branches.`
- `switchBranch` answers `refused` with, in order:
  `The working directory changed. Reopen the branch picker and try again.`
  when `cwd` differs from the Thread's working directory; the running-work
  sentence; the `blocked`
  sentence of a fresh read; `This local branch no longer exists.`; and
  `This branch is checked out in another worktree.` A branch that is already
  current answers `ready` with the read. Otherwise it runs
  `git -C <cwd> switch --no-guess -- <branch>`, which never creates, forces,
  stashes or fetches; a non-zero exit answers `refused` with
  `Git could not switch branches. Commit or stash conflicting local changes and try again.`,
  and success answers `ready` with the branches read again.
- **Running work** is the working directories of the Project's Threads with
  an active or queued prompt (`ThreadContext.busyCwds()`), and of each
  `terminal/v1.list` session that has not exited and is an agent session or a
  manual shell whose command is not `bash`. A branch switch is blocked when
  one of those directories is in the same repository root as the Thread's
  working directory.

### `discard`

[`src/host/discard.ts`](src/host/discard.ts) discards changes of one
repository that the Thread's changes read lists. It cannot be undone, so the
guards run first, and the first that fails answers `refused` with nothing
written:

1. `cwd` differs from the Thread's working directory:
   `The working directory changed. Reopen the Changes view and try again.`
2. `repository` holds a NUL, starts with `/`, has a `..` segment, or is not a
   repository of the changes read scoped to the Thread's working directory:
   `<repository> is not a repository of this working directory.`
3. Running work (as for `switchBranch`) is in the repository, in a directory
   inside it or in a directory above it; a directory outside the sandbox
   counts as the root, which holds every repository:
   `Wait for active prompts and terminal commands in this repository to finish before discarding changes.`
4. Targets. Without `paths`, every listed change except a nested repository
   or submodule (a path with a `.git` entry). With `paths` (deduplicated),
   each must equal a listed change's `path`, or
   `<path> has no change to discard.`, and must not be a nested repository or
   submodule, or `<path> is a separate repository. Discard does not change it.`
   An unchanged or ignored
   file, and a path under a symbolic link to a directory, has no listed change.
5. A conflicted target:
   `<path> has a merge conflict. Resolve it before discarding.`

Then one command per target, run as
`git --literal-pathspecs -C <repository> …`, so a path is never a pattern:

| Target                                            | Command                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| untracked (`??`)                                  | `clean --force --quiet -- <path>` (no `-x`: ignored files stay)                                                         |
| index letter `A` in a repository without a commit | `rm --force --quiet -- <path>`                                                                                          |
| any other change                                  | `restore --source=HEAD --staged --worktree -- <path>`, plus the origin of a rename (`R`); a copy's origin is left alone |

The first failing command stops the loop. A new changes read then decides the
answer: `discarded` lists the targets it no longer shows. A failed command
answers `failed` with the first non-empty line of its stderr (or
`git exited with <code> discarding <path>.`); a target the read still lists answers
`failed` with `<path> still has changes after Discard.`; otherwise `ready`
with `{ discarded }`.

### `changes`

`readProjectChanges` in [`src/host/changes.ts`](src/host/changes.ts); the
scope check in [`src/host/service.ts`](src/host/service.ts).

- A `path` that escapes the sandbox answers `invalid_path`, and a missing one
  `not_found` (`workspacePathKind` of `sandbox`).
- The repositories come from `listSandboxRepos`, which lists the outermost
  repository of each tree and stops at its boundary; a sandbox root that is
  missing or not a directory holds none. A repository belongs to the read when
  the path lies inside it or it lies inside the path; no path reads them all.
- Each repository is read with
  `git --no-optional-locks -C <repo> status --porcelain=v1 -z --untracked-files=all`.
  A record is `conflicted` when its letters contain `U` or are `AA` or `DD`,
  then `untracked` (`??`), `renamed` (`R` or `C`, with the next record as
  `originalPath`), `deleted` (`D`), `added` (`A`), else `modified`. `staged`
  is a tracked record whose index letter is not a space; `unstaged` is an
  untracked record or one whose worktree letter is not a space. Only changes
  whose path or origin lies inside the read's path are kept.
- `added` and `removed` total the lines of the kept changes:
  `git diff --numstat -z --no-ext-diff --no-textconv --find-renames HEAD --`
  for tracked files, and `git diff --no-index` against `/dev/null` for each
  untracked file, or for every listed file when the branch has no commit. A
  binary file counts 0. The untracked paths go in batches of at most 96 KiB
  of arguments per command.
- A failing status, line count or HEAD read throws
  (`Could not read repository changes.`,
  `Could not read changed line counts.`, `Could not read added line counts.`,
  `Could not read repository HEAD.`). No file content or patch is returned.

### `diff`

`projectChanges` in [`src/host/changes.ts`](src/host/changes.ts) reads the
same repositories with the same scope check. For each it returns the tracked
diff from the sandbox's `diff({ cwd })` and the entries of
`git -C <repo> status --porcelain`: `??` is `untracked`, `R` is `renamed` at
its destination, then `A` is `added`, `D` is `deleted`, and anything else is
`modified`. A repository whose status fails is left out. The window does not
call `diff`; the REST route `GET /projects/:id/diff` does.

### `fileDiff`

`readProjectFileDiff` in [`src/host/changes.ts`](src/host/changes.ts).

- Before the lease: a `repository` or `path` with a NUL, a leading `/` or a
  `..` segment, or an empty `path`, answers `ready` with `invalid_path`.
- `not_found` when `repository` has an empty or `.` part, when it is not a
  repository discovery would list (it has a `.git` entry, and every directory
  from the root down to it is a real directory with no `.git` entry), or when
  the path has no change. The status is read with a pathspec limited to the
  path; an addition or deletion is settled by the tracked status of the whole
  repository, so a rename whose other side lies elsewhere is paired.
- `original` is HEAD's copy (at `originalPath` for a rename), empty when HEAD
  lacks the path or the branch has no commit; `modified` is the working file,
  empty when it is missing. Each side is read up to 262,144 bytes (256 KiB):
  `truncated` is true when either side is longer, and each side keeps its
  first 262,144 bytes. `binary` is true when either side holds a NUL byte, and
  then both texts are empty.
- A HEAD that cannot be read, a HEAD entry that is not a file, a failed blob
  read, or a working path that is a directory or another non-file throws
  (`Could not read repository HEAD.`, `The original is not a file.`,
  `Could not read original file.`, `Could not read changed file.`).

## `git.changes/v1`

`GitChangesV1 = ref<GitChanges>('git.changes/v1')`, version 1.0.0, a local
client contract ([`src/contracts/index.ts`](src/contracts/index.ts),
[`src/client/changes/store.ts`](src/client/changes/store.ts)).

```ts
interface ChangesScope {
  projectId: string; // non-empty
  cwd?: string; // the raw working directory; absent: the root
}
// from files/contracts
type ReadState<Value> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: Value }
  | {
      status:
        | 'missing'
        | 'pending'
        | 'unavailable'
        | 'expired'
        | 'invalid_path'
        | 'not_found';
      retryAfterSeconds?: number;
    };
type ProjectChanges = { path?: string; repositories: RepositoryChanges[] };
interface ChangesObservation {
  read: ReadState<ProjectChanges>;
  decorations: ReadonlyMap<string, ChangeMark>; // by workspace-relative path
  error?: string; // the failed read's message
  fetching: boolean;
}
interface GitChanges {
  observe(
    scope: ChangesScope,
    listener: (state: ChangesObservation) => void,
  ): Disposable;
}
interface ChangeMark {
  description: string;
  count: number;
  tone?: string;
  letter?: string;
  struck?: boolean;
}
```

`observe` is the window's one changes read per Project and working directory
(see [Client state and reads](#client-state-and-reads)). It runs only while
observed, calls the listener at once and then on every change, and
sends nothing when a notification changes nothing it carries. The bundle's
own views read the store directly rather than through the contract.

## `files.decorations/v1`

The bundle provides the contract `files` declares, with cardinality `many`
([`src/client/changes/store.ts`](src/client/changes/store.ts)). `observe` takes
a `TreeScope` (`{ projectId, cwd? }`) and answers, from the same changes read,
`{ marks: { path, mark }[], error?, fetching }`. The list of marks is built
once per changes answer, so a refresh that answers the same changes keeps the
same list and the Files tree keeps its rows.

Marks ([`src/client/reads/change-tree.ts`](src/client/reads/change-tree.ts)),
keyed by `<repository>/<path>`:

- A changed file: `count: 1`, `description`
  `<status> · <Staged | Unstaged | Staged and unstaged>` plus
  ` · From <originalPath>` for a rename, `letter`
  `A` (added), `U` (untracked), `M`, `D`, `R` or `!` (conflicted), `struck`
  when deleted, and `tone` the text class of its colour.
- Each ancestor directory, up to the root and across repository roots:
  `count` the number of changed files under it, `description`
  `<n> changed file(s)`. Its status is `conflicted` when any change under it is, the
  shared status when all agree (untracked counting as added), else
  `modified`.
- Tones use the colour variables `--git-added` (added and untracked),
  `--git-modified`, `--git-deleted`, `--git-renamed` and `--git-conflicted`,
  which [`src/client/styles.css`](src/client/styles.css) declares for light
  (`:root`) and dark (`.dark`) themes.

## `git.open-comparison/v1`

A client command ([`src/client/commands.ts`](src/client/commands.ts)) with the
strict input `{ projectId, repository, path }` (`openComparisonInput`). It
calls `layout.tabs/v2.open` with:

- `id`: `JSON.stringify(['diff', projectId, repository, path])`;
- `title`: the file's name; `ariaLabel`: `<name> changes`; `tooltip`: the path;
- `tag`: `git-file-diff` with the props `projectId`, `repository` and `path`;
  `iconTag`: `git-file-diff-icon`;
- `menu`: one entry, "Open file", which runs `files.open-file/v1` with
  `{ projectId, path: <repository>/<path> }` and ignores a failure. The entry
  is fixed when the tab opens, so a deleted file's tab has it too.

The Changes view reads the current tab's id back to select the row of the
comparison it shows.

## Client state and reads

- **Store** ([`src/client/changes/store.ts`](src/client/changes/store.ts),
  [`src/client/state.ts`](src/client/state.ts)): one TanStack Query client per
  window, created at activation, with no automatic refetch (no retry by
  default, no refetch on focus or reconnect, `staleTime: 0`). Query keys:

  | Read               | Key                                                               |
  | ------------------ | ----------------------------------------------------------------- |
  | changes            | `['files', projectId, 'changes', cwd]`                            |
  | one comparison     | `['files', projectId, 'file-diff', repository, path]`             |
  | Thread summary     | `['thread', threadId, 'git', cwd]` (meta `projectId`)             |
  | branches           | `['thread', threadId, 'git', cwd, 'branches']` (meta `projectId`) |
  | stored credentials | `['credentials']`                                                 |

  The changes read, the comparison and the Thread summary retry a failed
  read three times with a delay of `min(1000 · 2^attempt, 8000)` ms; the
  branch read does not retry. A `pending` answer polls: the changes and
  comparison reads every second (the adapter's `retryAfterSeconds: 1`), the
  summary and the branch list every 3 seconds
  ([`packages/desktop/src/reads/read-policy.ts`](../../../packages/desktop/src/reads/read-policy.ts)).

- **Refresh**: `store.refresh(projectId)` rereads the active queries of that
  Project: its changes and comparisons, and each Thread summary and branch
  list whose meta
  names it. `requestProjectRefresh` asks `files.refresh/v1` when present,
  which rereads every registrant of the window, and otherwise refreshes this
  store alone. The Changes view, the footer and each comparison tab register
  their Project with `files.refresh/v1` while mounted
  ([`src/client/hooks/use-project-reads.ts`](src/client/hooks/use-project-reads.ts)).
- **Refresh after the tool**: while `chat.hooks/v2` is present, its
  `onThreadUpdateHook` handler requests the Project's refresh for every live
  `tool.finished` event whose call is named `git`
  ([`src/client/tool-refresh.ts`](src/client/tool-refresh.ts)). The hook's
  input is a structural copy matched by id
  ([`src/client/api/peers.ts`](src/client/api/peers.ts)):
  `{ projectId, threadId, threadName, update }`, where `update` is
  `{ kind: 'event', event: { event } }` or `{ kind: 'updated', thread }`.
- **Selection**: `workspace.selection/v1.current()` gives the ids and
  `runtime.records/v1` the records; both notify a change
  ([`src/client/hooks/use-selection.ts`](src/client/hooks/use-selection.ts)).
  While `workspace.selection/v1` is absent the views draw nothing.

### The host adapter

[`src/client/api/git-api.ts`](src/client/api/git-api.ts) calls
`git.commands/v1` with a `{ projectId }` or `{ threadId }` scope and checks
every value before it sends it and every answer it receives. From slice S65c
the call is the generated `CommandsService` over Connect, each answer read back
to today's shape and each failure read through `fromConnectError`:

- Guards that throw before the call: an id that is empty, longer than 200
  characters or holds a NUL (`The item identifier is invalid.`); a path with
  a NUL, a leading `/`, a `..` segment or more than 4,096 characters
  (`The workspace path is invalid.`); a working directory that is blank,
  holds a NUL or is longer than 4,096 characters
  (`The working directory is invalid.`); a branch that is empty, longer than 1,024 characters, holds a NUL
  or starts with `-` (`Invalid branch name.`). An empty comparison path
  answers `invalid_path` without a call.
- A contract error `unavailable`, `disconnected` or `generation_lost` becomes
  `Doric backend is unavailable.`, `invalid_output` becomes
  `Doric returned an invalid response.`, and any other failure
  `The request could not be completed.` An answer of the wrong shape is
  `Doric returned an invalid response.`
- A lease state answers as data, `pending` with `retryAfterSeconds: 1`; a
  refused read answers `not_found` or `invalid_path`.
- A Thread read that answers `missing` throws `The thread was not found.`
  `pending` and `inactive` answer a summary
  `{ repo: false, status: 'pending' | 'unavailable' }` and an empty branch
  list with `blocked` `Preparing environment…` or `Environment unavailable.`
- `switchBranch` throws the `refused` sentence, `The thread was not found.`
  for `missing`, and `The thread cannot perform this operation.` for another
  state. `discard` returns the host's outcome unchanged.

## Elements and surfaces

[`src/client/index.ts`](src/client/index.ts) and
[`src/client/elements.tsx`](src/client/elements.tsx). Each element renders in
light DOM over the store's query client, inside `StrictMode`, a tooltip
provider and a sidebar scope; none mounts a toaster.

| Tag                       | Where                                                                                                                                       | Draws                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `git-changes`             | region `shell.panel`, item `changes`, order 200, props `label: 'Changes'`, `iconTag: 'git-file-diff-icon'`, `badgeTag: 'git-changes-badge'` | the Changes view                                                                                      |
| `git-changes-badge`       | the Changes trigger's badge                                                                                                                 | `+added −removed` of the selected working directory, nothing when both are 0 or the read is not ready |
| `git-file-diff`           | the comparison tab (props `projectId`, `repository`, `path`)                                                                                | one comparison                                                                                        |
| `git-file-diff-icon`      | the tab trigger and the Changes trigger                                                                                                     | Lucide's `FileDiff` icon                                                                              |
| `git-workspace-cwd`       | region `shell.panel.footer`, item `git-cwd`, order 10                                                                                       | the working directory and branch                                                                      |
| `git-settings-versioning` | route `/settings/git`, child of `/settings`                                                                                                 | the Versioning section                                                                                |

The region `settings.sections` gets the item `versioning` (tag
`settings-link`, order 40, props `label: 'Versioning'`,
`path: '/settings/git'`, `icon: 'git-branch'` and the description "Which stored
credentials the agent commits and pushes with inside a Project."). Slot names
are written as literals checked against `SHELL_PANEL`, `SHELL_PANEL_FOOTER`
and `SETTINGS_SECTIONS`.

### The Changes view

[`src/client/changes/git-changes.tsx`](src/client/changes/git-changes.tsx),
[`src/client/changes/changes-tree.tsx`](src/client/changes/changes-tree.tsx),
[`src/client/changes/discard-dialog.tsx`](src/client/changes/discard-dialog.tsx).

- It reads the changes of the selected Project at the selected Thread's
  working directory. A read error, from the Files tree read or the changes
  read, shows in the toast `layout-panel-read` that the panel's views share;
  its retry requests the Project's refresh.
- States: no Project selected ("No project selected"); with
  `files.sandbox/v1`, a skeleton until the Files tree read of the same scope
  is ready, and that read's sandbox sentence ("No files to show") when it is
  not; then the changes read: "No changes read" while idle, a skeleton while
  loading, its sandbox sentence ("The changes cannot be read"), "No
  repositories", "No changes" when no repository has a change, else one tree
  per changed repository.
- A repository is a row at depth 0 labeled with its path (`workspace` for
  the root), with a branch icon and its `+added −removed` totals; Enter,
  Space, ArrowRight and ArrowLeft expand and collapse it. Its changed paths
  are `FileTree` rows below it, directories first, each with its mark.
  Collapsed directories are kept in memory per Project and root, keyed
  `[repository, path]`, and are not stored.
- Selecting a file row runs `git.open-comparison/v1`; the row whose
  comparison is the current tab is the selected one.
- With a selected Thread, a changed file's row has the context menu entry
  "Discard changes" and the repository row "Discard all changes" (both
  destructive; directory rows have none). Either opens a dialog titled
  "Discard changes to <name>?" or "Discard all changes in <name>?" that says
  "This cannot be undone." Confirming calls `discard` with the Thread's
  working directory; while it runs, the dialog shows "Discarding…" and cannot
  be dismissed. After `ready` or `failed` the view awaits the Project's
  refresh first. `ready` closes the dialog; any other answer keeps it open
  with its sentence: the host's message, `This Thread no longer exists.`,
  `This Thread is not running. Open it and try again.`,
  `The Project is starting. Try again in a moment.`, or
  `Could not discard the changes.` for a failed call.

### The comparison tab

[`src/client/diff/file-diff.tsx`](src/client/diff/file-diff.tsx),
[`src/client/diff/diff-toolbar.tsx`](src/client/diff/diff-toolbar.tsx),
[`src/client/diff/diff-footer.tsx`](src/client/diff/diff-footer.tsx).

- The comparison is read only once its tab is shown; a refresh keeps the
  editor mounted.
- The toolbar shows the change letter (tooltip
  `HEAD ↔ Working tree · <description>`), the path (struck through when deleted), the line counts the
  editor reports, a warning "Only the beginning of each file is shown; line
  counts are partial." when truncated, and "Open file", which runs
  `files.open-file/v1` with `<repository>/<path>`. "Open file" is enabled
  once the comparison is read or answers `not_found`, and never for a deleted
  file.
- A text change opens the diff editor of `desktop/ui/code` (Monaco), with the
  language from the file name and the colours `--git-added` and
  `--git-deleted`. Its footer switches between a unified and a side-by-side
  layout (side by side when space allows, unified below 700 px) and moves to
  the previous or next change.
- A binary change shows "Binary file changed". `not_found` shows "This file
  no longer has a comparison to show. It may have been committed, reverted or
  removed."; a lease state shows its sandbox sentence.

### The working directory and branch

[`src/client/cwd/workspace-cwd-view.tsx`](src/client/cwd/workspace-cwd-view.tsx),
[`src/client/cwd/workspace-cwd.tsx`](src/client/cwd/workspace-cwd.tsx),
[`src/client/cwd/branch-picker.tsx`](src/client/cwd/branch-picker.tsx),
[`src/client/domain/thread-git.ts`](src/client/domain/thread-git.ts).

- Without a selected Thread it draws nothing. Otherwise a footer button shows
  the Thread's working directory, `Preparing environment…` or
  `Environment unavailable` when the summary says so, and the branch
  (`@<sha>` when detached). Its tooltip adds the git line: the branch
  identity (`<name> · initial` when unborn, `DETACHED @<sha>` when detached),
  `↑ahead ↓behind` when tracking, `+staged !modified ?untracked`,
  `CONFLICT·<n>` and the operation in capitals, each part only when it
  applies, joined by a middle dot with a space on each side.
- The popover shows the worktree root (its name, a copy button, the full
  path) and "Main worktree" or "Linked worktree". In a repository it adds a
  branch button, disabled while the Thread is running, with the status line
  (the git line without the branch, or "Working tree clean"), which opens the
  branch picker.
- The branch picker searches local branches and shows each one's short
  commit and subject, and `In use: <worktree>` for a branch checked out
  elsewhere. A row is disabled while a switch runs, while the Thread runs,
  when the read has a `blocked` sentence, and for a branch in another
  worktree. While the Thread's environment is pending or unavailable it shows
  that sentence instead of the list. Choosing the current branch closes the
  picker; choosing another calls `switchBranch`, then awaits the Project's
  refresh and closes it; a failure shows its sentence in a toast and reads the
  branches again.

### The Versioning section

[`src/client/settings/versioning.tsx`](src/client/settings/versioning.tsx),
[`src/client/settings/settings-versioning.tsx`](src/client/settings/settings-versioning.tsx),
[`src/client/domain/credentials.ts`](src/client/domain/credentials.ts).

- It draws nothing until `settings.config/v1` and its draft are loaded. It
  lists stored credentials over Connect with the generated `SecretsService`
  (slice S65c, `SecretsService.List`); a list that is not an array, or holds
  an entry of another shape or of a kind other than
  `API_TOKEN`, `USERNAME_PASSWORD` or `GIT`, fails the whole read, and the
  section then offers no credential.
- Two selects: "Git identity" offers the `GIT` credentials and writes
  `gitCredentialId`; "GitHub token" offers the `API_TOKEN` credentials and
  writes `githubCredentialId`. Each option reads `<name> (<username>)`, or the
  name alone. Choosing "None" deletes the field from the draft. With no
  credential of a kind, the description says to add one under Credentials.
- The section only edits the settings window's draft through
  `settings.config/v1.setDraft`; the settings window saves it.

## Data and persistence

The bundle stores nothing of its own. Its host reads Git state from the
sandbox at each call. The window keeps its reads, the collapsed directories
and the client state in memory for the life of the activation. The
configuration fields `gitCredentialId` and `githubCredentialId` belong to the
host configuration that the settings window saves
([Settings](../../../docs/features/settings.md)), and the `GIT` credentials
are rows of `secrets/v1` ([Credentials](../../../docs/features/credentials.md)).

## Styles

[`src/client/styles.css`](src/client/styles.css) is the client part's
stylesheet. It imports Tailwind's utilities over `desktop/ui/tailwind.css` and
scans, with `@source`, this part, `packages/desktop/src` and the client
sources of the `layout`, `chat`, `settings`, `account` and `workspace`
bundles, so its utilities are the whole sorted set the window uses. It
declares the five `--git-*` colours, and, unlayered so that it wins over
Monaco's unlayered sheet, the rule
`.monaco-editor .monaco-scrollable-element > .scrollbar > .slider` that draws
Monaco's scrollbar slider as the window's 7 px pill.

## The host process

The host part also builds as a process (phase 3 of
[`docs/designs/grpc-processes.md`](../../../docs/designs/grpc-processes.md)),
into `dist/host/main.mjs`; the running host keeps the kernel entry
([`src/host/index.ts`](src/host/index.ts)) until slice S62.

- [`src/host/main.ts`](src/host/main.ts) runs `createGitProcessHost`
  ([`src/host/part.ts`](src/host/part.ts)) with `runBundle`, serving
  `CommandsService` (`git.commands/v1`) and `ToolHandlerService` (the tool).
- `activate` first tracks `SecretsService.registerKind` for the `GIT` kind
  through `context.registrations.track`, so the kind is replayed after a
  `core` restart, then registers the tool `git` with
  `{alwaysAvailable: false, order: 900}`, then binds `git.commands/v1`. It
  rejects with the first refusal; after a kind refusal no tool is
  registered. Before `activate` resolved, or after a refusal, every
  `git.commands/v1` method fails `unavailable` "git is not activated.".
- The operations of `git.commands/v1` live once in `createGitCommands`
  ([`src/host/commands.ts`](src/host/commands.ts)), used by the kernel
  through `kernelGitCommandPorts` ([`src/host/ports.ts`](src/host/ports.ts))
  and by the process through `routedGitCommandPorts`
  ([`src/host/routed.ts`](src/host/routed.ts)); the tool's ports are
  `kernelGitToolPorts` and `routedGitToolPorts`. Responses are encoded by
  [`src/host/codec.ts`](src/host/codec.ts).
- Routed, Thread methods open a session with `withThreadSession` (passing
  `exclusive`) and read the busy working directories from `ThreadState`;
  Project methods and the tool's sandbox run through `runOnProjectLease`,
  scoped to `{projectId}`. The tool wraps `Describe` so a lease failure keeps
  the provider's error instead of becoming a status answer. The busy check
  lists `terminal/v1` sessions with `List`; an `unavailable` answer counts as
  no sessions.

## Build and test

```console
npx nx run bundle-git:typecheck
npx nx run bundle-git:test
npx nx run bundle-git:build
```

- `build` and `typecheck` run `generate-proto` first.
- `build` ([`project.json`](project.json)) compiles the host and contracts
  (`tsconfig.json`) and the client with its stories (`tsconfig.client.json`),
  then runs the bundle CLI, which validates the manifest and the skills,
  dry-activates the host part and writes `dist/`.
- `test` builds first, compiles `tests/` with `tsconfig.spec.json` and
  `tsconfig.client-spec.json` into `dist-tests/`, and runs
  `dist-tests/tests/*.test.js` and `dist-tests/tests/client/*.test.js` with
  `node --test`. The host tests run real `git` and `sh` in a temporary
  directory through fakes of `runtime.workspace/v1`, `runtime.lease/v1` and
  `terminal/v1` ([`tests/support/runtime.ts`](tests/support/runtime.ts),
  [`tests/support/services.ts`](tests/support/services.ts)); the tests under
  `tests/client/` boot `happy-dom`. `tests/generated-imports.test.ts` imports
  `files/contracts/gen` and bundles it with `esbuild`, a dev dependency.
- `npx nx run doric-host:build-bundles` stages `dist/` into the Doric host's
  bundles at `app/backend/doric-host/dist/bundles/git`, which the host loads
  at startup.

## Feature docs

- [Git](../../../docs/features/git.md): the tool, the reads, the branch
  switch, Discard and the Versioning section across bundles.
- [Files](../../../docs/features/files.md): the Files tree, its marks and the
  refresh coordinator.
- [Projects and Threads](../../../docs/features/projects-and-threads.md): the
  working directory and the repository hint.
- [Terminal](../../../docs/features/terminal.md): the sessions the busy check
  lists.
- [UI redesign](../../../docs/features/ui-redesign.md): the panel, its footer
  and the tabs.
- [Credentials](../../../docs/features/credentials.md),
  [Settings](../../../docs/features/settings.md),
  [`cwd` tool](../../../docs/features/cwd-tool.md) and
  [Error messages](../../../docs/features/error-messages.md).
