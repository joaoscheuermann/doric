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
- **Contracts:** `files/v1` (host), `files.sandbox/v1`, `files.refresh/v1`
  and `files.decorations/v1` (client) and the `files.open-file/v1` command.
- **UI:** the Files view in the workspace panel, the file tab, and the
  drawing of `edit` and `write` calls in the chat (1.8.0).

## Tools

The host part registers these tools with `tools/v1` at fixed global
model-visible positions:

| Order | Tool    | What it does                                                                                |
| ----- | ------- | ------------------------------------------------------------------------------------------- |
| 100   | `cwd`   | Report the thread's working directory, or move it; say whether it is a repository root.     |
| 200   | `edit`  | Change a file through unique, exact-text replacements.                                      |
| 300   | `find`  | Find files by glob; respects `.gitignore`, bounded output.                                  |
| 400   | `grep`  | Search file contents with paths and line numbers; bounded output.                           |
| 600   | `tree`  | Show the directory structure, three levels by default; skips hidden files except `.agents`. |
| 800   | `write` | Create or overwrite a whole file, creating parent directories.                              |

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
- `files/v1` 1.2.0 adds the two writes behind New file and New folder,
  `createFile` and `createDirectory` (`{ directory, name }`, desktop-exposed,
  on the same lease). Each makes one empty entry and never overwrites: the name
  is a single segment (no `/`, `\`, NUL, `.` or `..`, at most 255 UTF-8 bytes,
  else `refused` `invalid-name`); `directory` is workspace-relative or absolute
  under the sandbox root, and must be an existing directory inside it (else
  `outside` or `no-directory`). One command creates the entry and fails when
  the name exists (`set -C; : >` for a file, `mkdir --` for a directory), so a
  name made in between answers `exists` and keeps its content. Success answers
  `created` with the workspace-relative path; any other command failure answers
  `failed` with its first stderr line. These are the only repository writes of
  the bundle's UI (HC-007).
- `files/v1` 1.3.0 adds `directories` (`{ paths, root? }`, desktop-exposed):
  several directories listed one level each in one sandbox command, without
  sizes, one answer per asked path in order (`listed` with its entries, or
  `not_found`, `not_directory`, `invalid_path`). The rules are
  `listSandboxDirectories`' from `sandbox`, applied as the whole-tree read from
  `root` applies them, so a directory lists exactly the children `tree` nests.
- `files.sandbox/v1` (client) keeps the window's one tree read per Project and
  root, shared with the bundles that gate on it. It is read per directory: the
  read holds the root and the folders open in the expansion store, and a
  folder that opens later is read on its own (the observation's `loading`
  names it meanwhile) and merged in; one whose read fails closes again and
  its failure is the observation's `error`.
- The contract `files.decorations/v1` 1.0.0, declared from `files` 1.9.0 (client, many) and provided by other bundles;
  `files` lists it under `optional`: each provider's `observe({ projectId, cwd }, listener)`
  answers its marks for the tree, a list of `{ path, mark }` with its `error`
  and `fetching`. The Files view asks every provider for the tree it shows and
  draws their merge: for a path two providers mark, the mark of the provider
  whose bundle id is smaller (by code unit) wins; the first error in bundle-id
  order shows in the panel's read toast, and the view refreshes while any
  provider fetches; the tree's own read error wins over any provider's error.
  With no provider no row is marked. A mark is a `FileMark`: `description`
  (the row's accessible label and tooltip suffix), `count` (a directory's
  badge: how many marked entries lie below it), and the optional `tone` (CSS
  class names of the marked name and badge), `letter` (a file's badge letter)
  and `struck` (whether a file's name is struck through). `git` provides it with
  the marks of its changes read; `files` names no `git.*` contract.
- `files.refresh/v1` (client) is the Project refresh coordinator. It rereads
  when an `edit` or `write` call finishes in any held conversation (chat's
  `onThreadUpdateHook`), when the chat starts to hold a Thread, a held
  Thread's working directory changes or its run ends, not when it starts
  (chat's `onSandboxActivityHook`), when the selected Project or Thread
  changes, when `git` asks for it after a finished `git` call (its
  `requestProjectRefresh`), when the terminal store asks for it because a
  followed Project's terminals changed id, state, command or cwd, on window
  focus, and every 15 s while the window is visible and connected. Both hooks are `chat.hooks/v2`'s, listed under `optional`
  (files 1.8.1).
- `files.open-file/v1` opens a file as a workspace tab (`files-file-view`).
  The tab's trigger draws the `files-file-icon` element (`iconTag`). Its
  context menu holds "Reveal in Files" (`layout.tabs/v2@2.0.0` `menu`, so the
  bundle requires `layout.tabs/v2@^2.0.0`): it opens the
  file's ancestor directories under the tree's root, selects the Files view
  (`select('files')`) and selects the tab, so the tree selects the file's row. A
  file outside the root only selects the Files view.
- The Files view (`files-tree`) is a `shell.panel` region item, selected from
  the Files column header's tab strip, whose icon is the `files-file-icon`
  element. The bundle defines no panel toggle; it requires `layout.panel/v3`,
  which starts with no view, and selects the Files view when it activates and
  from Reveal in Files.
- A row's context menu in the Files view: on a file row, "Copy relative path"
  copies the path relative to the tree's root (the Thread's working
  directory); on a folder row, "New file" and "New folder" open the folder
  and show an inline name row as its first child. Enter sends the trimmed
  name to `createFile` or `createDirectory`; Escape, a blur or an empty name
  cancels. A created entry closes the row and refreshes the Project
  (`files.refresh/v1`); any other answer shows its reason under the row,
  which keeps the typed name. On an app whose `FileTree` draws no row menus
  these entries are absent and the view works as before.

The client reads the selected Project and Thread ids through
`workspace.selection/v1` (required, `^1.0.0`) and their records through
`runtime.records/v1` (files 1.7.8); it imports `WorkspaceSelectionV1` from
`workspace/contracts`. Without `workspace` the bundle is quarantined.

From 1.8.0 (bundle isolation 5(b)) `files` draws its tools' calls in the chat
through `chat.views/v1`, listed under `optional`, each registration in a
`whenAvailable` callback of its own in `src/client/index.ts`; the specs are in
`src/client/chat/views.ts`:

- `edit` and `write` are drawn by `files-edit-call`
  (`src/client/chat/edit-call.tsx`), a block of its own outside the activity
  group, open until the reader closes it: "Editing", "Edited" or "Failed to
  edit", the file name, the `+added / −removed` counts and the unified diff,
  or the failure notice with the fallback code `tool_failed`.
- `view-image` keeps the chat's generic row, open until the reader closes it,
  so the image the agent looked at stands beside it.

The element imports only the chat's types from `chat/contracts`, and needs
platform 1.10.0 (`engines.doric` `^1.10.0`) for
`desktop/ui/collapsible-block`. Without the chat the bundle registers nothing,
and without `files` the chat draws these calls as generic rows.

`src/client/styles.css` ships, unlayered, the Monaco scrollbar slider rule
(`.monaco-scrollable-element > .scrollbar > .slider`), because the file viewer
draws a Monaco editor; the layout's sheet no longer carries it. The sheet also
scans the shared components' sources, `account`'s and `workspace`'s client
sources among them (`@source`), so its utilities are the whole sorted set the
window uses.

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
