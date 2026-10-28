# Files bundle

`files` lets the Doric agent work with the code in its Project: it can map
the workspace, search it, edit or write files, and move its working directory
as the work moves into a repository. It also gives you the Files view and file
tabs in the desktop app, so you can browse the same workspace the agent sees.

It is a feature bundle with a host part (the tools and `files/v1`) and a
client part (the desktop UI), loaded by the `bundle` platform. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tools:** `cwd`, `edit`, `find`, `grep`, `tree` and `write`, all always
  available.
- **Skills:** a baseline execution discipline plus focused skills for
  discovery, search, inspection, editing, validation and synthesis.
- **Contracts:** `files/v1` (host), `files.sandbox/v1` and `files.refresh/v1`
  (client) and the `files.open-file/v1` command.
- **UI:** the Files view in the workspace panel and the file tab.

## Tools

The host part registers these tools with `tools/v1` at fixed global
model-visible positions:

| Order | Tool    | What it does                                                                            |
| ----- | ------- | --------------------------------------------------------------------------------------- |
| 100   | `cwd`   | Report the thread's working directory, or move it; say whether it is a repository root. |
| 200   | `edit`  | Change a file through unique, exact-text replacements.                                  |
| 300   | `find`  | Find files by glob; respects `.gitignore`, bounded output.                              |
| 400   | `grep`  | Search file contents with paths and line numbers; bounded output.                       |
| 600   | `tree`  | Show the directory structure; skips hidden files except `.agents`.                      |
| 800   | `write` | Create or overwrite a whole file, creating parent directories.                          |

Positions 500 and 700 belong to the `terminal` tool of the
[`terminal`](../terminal/README.md) bundle and the `web` tool of the
[`web`](../web/README.md) bundle.

`cwd` reports and moves the calling thread's working directory, and every other
relative path in this bundle resolves against it at call time. A move is refused
unless the path names a directory inside the workspace root. Its result says
whether the directory is a repository root, and there reminds the model to load
the matching skills; see
[docs/features/cwd-tool.md](../../../docs/features/cwd-tool.md).

The tools reach the working directory through `runtime.workspace/v1` and the
Project sandbox through `runtime.lease/v1`, both in `requires`.

## Skills

`goal-directed-tool-use` is the baseline skill and is always available.
Additional focused skills cover workspace discovery, content search, focused
file inspection, dependency tracing, exact-text editing, whole-file writing,
multi-file consistency, shell command execution, failure diagnosis, change
validation and evidence-grounded synthesis.

Skills live in `src/skills/<NN>-<name>/SKILL.md`. Each one's `order`
frontmatter (100 to 1300) sets its global position in the system prompt, and
the two-digit folder prefix mirrors it; position 1200 is the `web-research`
skill of the `web` bundle. A skill's `allowed-tools` resolve against the whole
`tools/v1` catalog, so several of these skills name the `terminal` tool.

## Desktop UI and contracts

- `files/v1` (host) answers the Project sandbox reads of the Files view and the
  file tab: one directory level, the whole tree below a path, and one file as
  bounded text (up to 256 KiB) or, with `encoding: 'base64'` (1.1.0), as its
  bytes up to 4 MiB, which papercraft reads a preview sheet's fonts and images
  with. Each read runs on the Project's current lease
  through `runtime.lease/v1.withLease` and never acquires one; a Project
  without a lease answers its lease state.
- `files.sandbox/v1` (client) keeps the window's one tree read per Project and
  root, shared with the bundles that gate on it.
- `files.refresh/v1` (client) is the Project refresh coordinator. It rereads
  when a sandbox-writing tool runs in any held conversation (chat's
  `onSandboxActivityHook`), when the selected Project or Thread changes, on
  window focus, and every 15 s while the window is visible and connected.
- `files.open-file/v1` opens a file as a workspace tab (`files-file-view`).
- The Files view (`files-tree`) is a `layout.panel` region item, selected from
  the workspace's tab bar; `files-toggle` is the panel toggle.

## Change the bundle

1. Add or update a tool in `src/host/tools/` with `defineTool` from `tool`
   (`execute(payload, call, services)`), and register it with its `order` in
   `src/host/index.ts`.
2. Add or update a skill at `src/skills/<NN>-<name>/SKILL.md`. Its YAML
   frontmatter must declare `name` and `description`, and may set
   `alwaysAvailable`, `order` and `allowed-tools` (any tool in the `tools/v1`
   catalog).
3. Declare every contract the bundle uses in `manifest.json` `requires`.
4. Build and test the bundle; the build validates the manifest and skills and
   dry-activates the host part.

## Development

```console
npx nx build bundle-files
npx nx typecheck bundle-files
npx nx test bundle-files
```

The build writes `bundles/features/files/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/files`. To rebuild and stage every bundle
used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
