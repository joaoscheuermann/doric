# Git bundle

`git` lets the Doric agent clone, commit, rebase, resolve conflicts and push
inside its Project's sandbox, and lets you follow that work in the desktop
app: the Changes view, file comparisons, the current branch in the footer and
the Versioning settings for the identity the agent commits with.

It is a feature bundle with a host part (the `git` tool and
`git.commands/v1`) and a client part (the desktop UI), loaded by the `bundle`
platform. See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tool:** `git`, structured and non-interactive Git commands in the sandbox.
- **Skills:** cloning, commit preparation, conflict resolution, rebasing,
  remote synchronization and linked worktrees.
- **Contracts:** `git.commands/v1` (host), `git.changes/v1` (client) and the
  `git.open-comparison/v1` command.
- **Credentials:** the `GIT` credential kind, a Git identity (username and
  email) registered with `secrets/v1`.
- **UI:** the Changes view, the comparison tab, the footer's working directory
  and branch picker, and the Versioning settings section.

## The `git` tool

The routable `git` tool (order 900, not always available) executes `git` with
an argument array inside the sandbox:

- it does not invoke a shell;
- it runs in the thread's current working directory by default, and a relative
  `working_directory` resolves against that directory;
- it keeps the working directory under the sandbox root;
- it runs non-interactively (`GIT_TERMINAL_PROMPT=0`, no editor) with a
  default 120 s timeout, at most 600 s;
- it bounds captured stdout and stderr.

Authentication must be provided by the runtime; credentials do not belong in
tool arguments. The tool reaches the working directory through
`runtime.workspace/v1` and the sandbox through `runtime.lease/v1`, and
registers itself with `tools/v1`.

## Skills

Focused skills cover:

- cloning;
- commit preparation;
- conflict resolution;
- rebasing;
- remote synchronization;
- linked worktrees.

Skills live in `src/skills/<name>/SKILL.md`; each one's `order` frontmatter
(2100 to 2600) sets its global position in the system prompt.

## Desktop UI and contracts

- `git.commands/v1` (host) answers a Thread's Git summary and local branches,
  the branch switch, and the Project's changes, diff and one file's
  comparison. Thread reads run on the live Thread through
  `runtime.workspace/v1`, Project reads on the Project's current lease through
  `runtime.lease/v1`; none acquires a lease. While some bundle provides
  `runtime.terminals/v1`, the Project's terminals feed the branch switch's busy
  check; without one, only running prompts block a switch.
- `git.changes/v1` (client) keeps the window's one changes read per Project and
  working directory, shared with the bundles that decorate from it, such as
  the files tree.
- `git.open-comparison/v1` opens one file's comparison as a workspace tab
  (`git-file-diff`).
- The Changes view (`git-changes`, with its `git-changes-badge`) is a
  `layout.panel` item, the working directory and branch (`git-workspace-cwd`)
  a `layout.footer` item, and the Versioning section (`/settings/git`) chooses
  which stored credentials the agent commits and pushes with.

## Change the bundle

1. Update the tool in `src/host/tools/git.ts` or add a skill at
   `src/skills/<name>/SKILL.md`.
2. A skill's `allowed-tools` resolve against the whole `tools/v1` catalog.
3. Declare every contract the bundle uses in `manifest.json` `requires`.
4. Build and test; the build validates the manifest and skills and
   dry-activates the host part.

## Development

```console
npx nx build bundle-git
npx nx typecheck bundle-git
npx nx test bundle-git
```

The build writes `bundles/features/git/dist`, which `doric-host:build-bundles`
stages into `app/backend/doric-host/dist/bundles/git` for the Doric host to
load at startup. To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
