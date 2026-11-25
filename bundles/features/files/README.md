# files

`files` lets the Doric agent work with the code of its Project: it maps the
workspace, searches it, looks at an image in it, edits or writes files, and
moves its working directory as the work moves into a repository. It also gives
you the Files view and the file tabs of the workspace window, so you browse the
same workspace the agent works in.

It is a feature bundle with a host part (the tools, the skills and `files/v1`)
and a client part (the window's views, `files.sandbox/v1`, `files.refresh/v1`
and the command `files.open-file/v1`). The [main README](../../../README.md)
describes Doric as a whole, and [`packages/bundle`](../../../packages/bundle/README.md)
how a bundle is built, loaded and activated. The flows across bundles are in
the feature docs [Files](../../../docs/features/files.md),
[The `cwd` tool](../../../docs/features/cwd-tool.md),
[Projects and Threads](../../../docs/features/projects-and-threads.md),
[Terminal](../../../docs/features/terminal.md),
[UI redesign](../../../docs/features/ui-redesign.md),
[Attachments](../../../docs/features/attachments.md),
[Coding workflow](../../../docs/features/coding-workflow.md),
[Error messages](../../../docs/features/error-messages.md),
[Git](../../../docs/features/git.md),
[papercraft](../../../docs/features/papercraft.md) and
[Web research](../../../docs/features/web-research.md). This README is the
bundle's complete description.

## Manifest

[`manifest.json`](manifest.json):

| Field             | Value                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifestVersion` | `1`                                                                                                                                                                                                                                                                                                                             |
| `id`              | `files`, version `1.10.0`, engine `doric ^1.10.0`                                                                                                                                                                                                                                                                               |
| `description`     | "Core capabilities available to the Doric agent."                                                                                                                                                                                                                                                                               |
| `provides`        | `files/v1@1.4.0`, `files.sandbox/v1@1.0.0`, `files.refresh/v1@1.0.0`, `files.open-file/v1@1.0.0`                                                                                                                                                                                                                                |
| `requires`        | `tools/v1@^1.5.0`, `skills/v1@^1.3.0`, `runtime.workspace/v1@^1.2.0`, `runtime.lease/v1@^1.4.0`, `runtime.attachments/v1@^1.1.0`, `ui/v1@^1.0.0`, `regions/v1@^1.0.0`, `commands/v1@^1.0.0`, `hooks/v1@^1.0.0`, `workspace.selection/v1@^1.0.0`, `runtime.records/v1@^1.0.0`, `layout.panel/v3@^3.0.0`, `layout.tabs/v2@^2.0.0` |
| `optional`        | `files.decorations/v1`, `chat.hooks/v2`, `chat.views/v1`, `log/v1`, `secrets/v1`                                                                                                                                                                                                                                                |
| `desktopScope`    | `files/v1`: `projectId`, `threadId`, `promptId`                                                                                                                                                                                                                                                                                 |

The engine `^1.10.0` is what `desktop/ui/collapsible-block`, which draws the
edit block in the conversation, needs
([`packages/bundle/src/runtime/version.ts`](../../../packages/bundle/src/runtime/version.ts)).
`files.decorations/v1` is declared by this bundle and provided by others, so
it is listed under `optional` and never under `provides` ([`src/contracts/index.ts`](src/contracts/index.ts),
[`tests/support/boundaries.mjs`](../../../tests/support/boundaries.mjs)). The
bundle has no settings, routes or storage of its own.

## Parts

- **Protos** ([`proto/doric/files/v1/files.proto`](proto/doric/files/v1/files.proto)):
  the package `doric.files.v1` and its `FilesService`; beside it
  `doric/files/{sandbox,decorations,refresh,open_file}/v1`, the client
  contracts `files` declares. `files.decorations/v1` lives here although `git`
  provides it, because a `.proto` lives in the project that declares its
  contract (spec A57). The `generate-proto`
  target writes the protobuf-es code into `src/contracts/gen/` (ignored by
  Git), exported as `files/contracts/gen/*`; it depends on
  `@bufbuild/protobuf`; `@bufbuild/protovalidate` is a devDependency, used only
  by `tests/generated-imports.test.ts`.
- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts) and
  [`src/contracts/reads.ts`](src/contracts/reads.ts), exported as
  `files/contracts` through [`package.json`](package.json)): the five
  contracts below, their schemas and the sandbox vocabulary, listed under
  [Exports of `files/contracts`](#exports-of-filescontracts).
- **Host** ([`src/host/index.ts`](src/host/index.ts)): on activation it
  provides `files/v1` ([`src/host/reads.ts`](src/host/reads.ts),
  [`src/host/writes.ts`](src/host/writes.ts)) and registers seven tools with
  `tools/v1` ([`src/host/tools/`](src/host/tools)). The build copies the
  skills of [`src/skills/`](src/skills) into the bundle.
- **Host process** ([`src/host/main.ts`](src/host/main.ts),
  `createFilesHost` in [`src/host/service.ts`](src/host/service.ts)), beside
  the kernel until slice S62 of
  [`docs/designs/grpc-processes.md`](../../../docs/designs/grpc-processes.md):
  the seven tools run over `FilesToolPorts`
  ([`src/host/ports.ts`](src/host/ports.ts)), shared with the kernel; the
  routed ports ([`src/host/routed.ts`](src/host/routed.ts)) call
  `runtime.workspace/v1` and `runtime.lease/v1`, and `view-image` streams
  `ReadFileBytes` into `runtime.attachments/v1.Attach`. The process serves
  `files/v1` 1.4.0 ([`src/host/lease.ts`](src/host/lease.ts)) on the lease
  scope `{ projectId }` only, through `runOnProjectLease` of
  `runtime/contracts`: each method is one `Describe`, then steps with
  `expectSandboxId`, and the first not-ready step is the `{ status }` answer.
  `ReadBytes` streams its head, then chunks of at most 1 MiB (truncated at
  `BYTES_LIMIT`, `binary` on a NUL byte). Before activation its methods fail
  `unavailable`.
- **Client** ([`src/client/index.ts`](src/client/index.ts)): on activation it
  creates the window's sandbox store and refresh coordinator and binds them to
  the activation's services ([`src/client/state.ts`](src/client/state.ts));
  provides `files.sandbox/v1` and `files.refresh/v1`; defines the elements
  `files-tree`, `files-file-view`, `files-file-icon` and `files-edit-call`
  ([`src/client/elements.tsx`](src/client/elements.tsx),
  [`src/client/chat/edit-call.tsx`](src/client/chat/edit-call.tsx));
  registers the command `files.open-file/v1`
  ([`src/client/commands.ts`](src/client/commands.ts)); adds the Files view to
  the region `shell.panel` and selects it with `layout.panel/v3.select('files')`
  (a missing panel is ignored); binds the coordinator to the workspace
  selection while `workspace.selection/v1` is served; registers on
  `chat.hooks/v2` while it is defined; and registers three tool drawings on
  `chat.views/v1` while it is served, each in a `whenAvailable` of its own so
  that one refusal leaves the others. Deactivation disposes all of it, clears
  the query cache, the open folders and the bound state.
- **Stylesheet** ([`src/client/styles.css`](src/client/styles.css)): the
  utilities the elements use over the platform theme, with `@source` lines for
  this bundle, `packages/desktop/src` and the client sources of the bundles
  `layout`, `chat`, `settings`, `account` and `workspace`, so the sheet's
  utilities are the whole sorted set the window uses; and one unlayered rule
  that shapes Monaco's scrollbar slider
  (`.monaco-scrollable-element > .scrollbar > .slider`) as the app's other
  scroll areas.

## Contracts provided

`CallArg` and `Disposable` are those of `bundle/contracts`
([Contracts](../../../docs/architecture/bundles/contracts.md)). Every method
table of [`src/contracts/index.ts`](src/contracts/index.ts) is validated on
each call: an input or output that does not match its schema is a contract
error.

### `files/v1` (host, 1.3.0)

`Files`, referenced as `FilesV1`, provided by
[`src/host/reads.ts`](src/host/reads.ts). The Project is `call.scope.projectId`
(`services.use(FilesV1, { projectId })` on the host; the window binds the
generated `FilesService` to it over Connect, `services.use(FilesService,
{ projectId })`, slice S65d). Every method is exposed to the
desktop (`expose: 'desktop'`), and runs on the Project's current lease through
`runtime.lease/v1.withLease`, which never acquires a lease:

```ts
type LeaseOutcome<T> =
  | { status: 'ready'; value: T }
  | { status: 'pending' | 'unavailable' | 'expired' | 'missing' };

interface Files {
  directory(
    input: { path?: string },
    call?,
  ): Promise<LeaseOutcome<DirectoryRead>>;
  tree(input: { path?: string }, call?): Promise<LeaseOutcome<TreeRead>>;
  directories(
    input: DirectoriesInput,
    call?,
  ): Promise<LeaseOutcome<DirectoriesRead>>;
  content(input: ContentInput, call?): Promise<LeaseOutcome<ContentRead>>;
  createFile(input: CreateInput, call?): Promise<LeaseOutcome<CreateOutcome>>;
  createDirectory(
    input: CreateInput,
    call?,
  ): Promise<LeaseOutcome<CreateOutcome>>;
}

interface SandboxEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
}
interface SandboxTreeNode extends SandboxEntry {
  children?: SandboxTreeNode[];
}

type DirectoryRead =
  | { status: 'listed'; path: string; entries: SandboxEntry[] }
  | { status: 'not_found' | 'not_directory' | 'invalid_path' };
type TreeRead =
  | { status: 'listed'; path: string; entries: SandboxTreeNode[] }
  | { status: 'not_found' | 'not_directory' | 'invalid_path' };

interface DirectoriesInput {
  paths: string[];
  root?: string;
} // 1..1000 paths
type DirectoriesRead = {
  status: 'listed';
  directories: DirectoryListingRead[];
};
type DirectoryListingRead =
  | { path: string; status: 'listed'; entries: SandboxEntry[] }
  | { path: string; status: 'not_found' | 'not_directory' | 'invalid_path' };

interface ContentInput {
  path: string;
  encoding?: 'utf8' | 'base64';
}
type ContentRead =
  | {
      status: 'read';
      path: string;
      content: string;
      truncated: boolean;
      binary: boolean;
    }
  | { status: 'not_found' | 'not_file' | 'invalid_path' };

interface CreateInput {
  directory: string;
  name: string;
}
type CreateOutcome =
  | { status: 'created'; path: string }
  | {
      status: 'refused';
      reason: 'exists' | 'invalid-name' | 'outside' | 'no-directory';
    }
  | { status: 'failed'; message: string };
```

Inputs are strict objects (an unknown field is refused). Outputs are loose
(an extra field passes), except the `CreateOutcome` inside a `ready` answer of
`createFile` and `createDirectory`, which is strict (`createOutcomeSchema`).
`SandboxEntry` and `SandboxTreeNode` are the types of
[`packages/sandbox`](../../../packages/sandbox/src/lib/files.ts). A path is
workspace-relative, or absolute under the sandbox root; no `path` is the
workspace root.

- `directory` lists one directory level, files with their sizes, and `tree`
  the whole tree below the path in one read, each directory carrying
  `children`; both read through the
  [workspace's visibility rules](#workspace-visibility-rules). A missing path
  answers `not_found`, a file `not_directory`, and any other refusal
  `invalid_path` ([`src/host/reads.ts`](src/host/reads.ts)).
- `directories` lists every asked path one level each, without sizes, in one
  sandbox command, and answers one entry per asked path in the order asked,
  `path` being the path as asked. Each listing applies the rules the
  whole-tree read from `root` applies (the workspace root when `root` is
  absent), so a directory lists exactly the children `tree` nests under it
  ([`src/host/reads.ts`](src/host/reads.ts),
  [`packages/sandbox/src/lib/files.ts`](../../../packages/sandbox/src/lib/files.ts)).
  `DIRECTORIES_LIMIT` is 1,000.
- `content` reads one file. An escaping path answers `invalid_path`, a missing
  one `not_found`, anything but a regular file `not_file`. It runs
  `head -c <limit + 1> -- <path>` once: as text the limit is 262,144 bytes
  (`CONTENT_LIMIT_BYTES`), with `encoding: 'base64'` 4,194,304 bytes
  (`BYTES_LIMIT`). `truncated` says the file is longer than the limit, and
  `binary` that the kept bytes hold a NUL. As text, `content` is the kept
  bytes as UTF-8, or empty when `binary`; as base64 it is the kept bytes
  whatever they hold. A failing `head` answers `not_found`
  ([`src/host/reads.ts`](src/host/reads.ts)).
- `createFile` and `createDirectory` make one empty entry and never overwrite
  ([`src/host/writes.ts`](src/host/writes.ts)):
  1. A `name` that is empty, `.`, `..`, holds `/`, `\` or NUL, or passes 255
     UTF-8 bytes answers `refused` `invalid-name`.
  2. A `directory` that escapes the workspace answers `refused` `outside`;
     one that is not an existing directory `refused` `no-directory`.
  3. One command makes the entry and fails when the name exists:
     `sh -c 'set -C; : > "$1"'` for a file, `mkdir -- <path>` for a directory.
     Success answers `created` with the entry's workspace-relative path.
  4. On a failure, a name that now exists (`[ -e ] || [ -L ]`) answers
     `refused` `exists` and keeps its content; any other failure answers
     `failed` with the command's first non-blank stderr line.

### `files.sandbox/v1` (client, 1.0.0)

`FilesSandbox`, referenced as `FilesSandboxV1`, provided by
[`src/client/sandbox-store.ts`](src/client/sandbox-store.ts). It is the
window's one tree read per Project and root, shared by every observer:

```ts
interface FilesSandbox {
  observeTree(
    scope: TreeScope,
    listener: (state: TreeObservation) => void,
    call?,
  ): Disposable;
}
interface TreeScope {
  projectId: string;
  cwd?: string;
} // projectId non-empty
interface TreeObservation {
  read: ReadState<ProjectTreeNode[]>;
  error?: string; // the failed read's message
  fetching: boolean;
  loading?: ReadonlySet<string>; // open directories being read
}
type ReadState<V> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: V }
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
interface ProjectTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  children?: ProjectTreeNode[];
}
```

The method takes its two arguments as one tuple input
(`filesSandboxMethods.observeTree`).

- `cwd` is the Thread's raw working directory; the tree's root is
  `workspacePath(cwd)`, the workspace root when `cwd` is absent. The read is
  cached under the key `['files', projectId, 'tree', cwd]` and runs only while
  observed ([`src/client/sandbox-store.ts`](src/client/sandbox-store.ts)).
- The read is per directory: one `files/v1.directories` call, rooted at the
  tree's root, lists the root and every open directory of the scope, and
  [`src/client/reads/directory-tree.ts`](src/client/reads/directory-tree.ts)
  assembles them into `read.value`, each read directory carrying `children`.
  A directory counts as open when it is expanded, under the root, and all its
  ancestors below the root are open; a directory whose parent's listing holds
  no directory of that path is left out, with everything below it.
- A directory opened while the tree is not reading is read on its own, in one
  call with the other unread open directories, and merged into the cached
  read; meanwhile `loading` names it. When that read fails, the directories
  close again and its message is `error` until a later read succeeds. When it
  answers that a directory is gone, the tree is read again
  ([`src/client/sandbox-store.ts`](src/client/sandbox-store.ts)).
- A root that is not listed makes `read` `not_found` (when it is missing) or
  `invalid_path`. A lease state becomes `read` with that status, `pending`
  carrying `retryAfterSeconds: 1`. A failed reread keeps a tree already
  on screen, and otherwise shows `loading`
  ([`src/client/reads/state.ts`](src/client/reads/state.ts),
  [`src/client/api/reads.ts`](src/client/api/reads.ts)).
- An observation that changes nothing it carries is not sent, and an unchanged
  answer keeps its `read` object
  ([`src/client/sandbox-store.ts`](src/client/sandbox-store.ts)).

### `files.refresh/v1` (client, 1.0.0)

`FilesRefresh`, referenced as `FilesRefreshV1`, provided by
[`src/client/refresh/coordinator.ts`](src/client/refresh/coordinator.ts). It
is the window's one Project refresh coordinator, with no React:

```ts
interface FilesRefresh {
  register(reads: ProjectReads, call?): Disposable;
  request(projectId: string, options?: { periodic?: boolean }, call?): void;
}
interface ProjectReads {
  projectId: string; // non-empty
  active(): boolean; // true while the registrant shows something
  refresh(options: { periodic: boolean }): Promise<void>;
}
```

`register` takes `ProjectReads` as one object, checked by shape; `request`
takes `[projectId, options?]` as one tuple input, `options` strict
(`filesRefreshMethods`).

- `request` calls `refresh` of every registrant of that Project and of no
  other, and ignores a rejected `refresh`. `register` adds a registrant and
  re-evaluates the triggers; disposing it removes it and re-evaluates them
  ([`src/client/refresh/coordinator.ts`](src/client/refresh/coordinator.ts)).
- The workspace the triggers read is bound while `workspace.selection/v1` is
  served: the selected Project and Thread records, the Threads of the selected
  Project while their read is ready, the connection of `runtime.records/v1`,
  and both contracts' notifications
  ([`src/client/api/selection.ts`](src/client/api/selection.ts),
  [`src/client/index.ts`](src/client/index.ts)).
- After every notification and registration the coordinator compares a
  signature of: the selected Project's id and state, the selected Thread's id
  and working directory, each Thread of the Project (its id, its state before
  its run started, how many runs it finished, its working directory), whether
  a registrant of the selected Project is active, and the connection. When it
  changed, and a Project is selected and the window is connected, it requests
  a refresh of that Project. A Thread that starts to run changes nothing; a
  run that ends, in any state, is a change
  ([`src/client/refresh/coordinator.ts`](src/client/refresh/coordinator.ts)).
- While a registrant of the selected Project is active and the window is
  connected, window `focus` and `visibilitychange` request a refresh when the
  document is visible, and a poll every 15 s (`PERIODIC_REFRESH_MS`) requests
  a periodic one when it is visible. There is no filesystem watcher
  ([`src/client/refresh/coordinator.ts`](src/client/refresh/coordinator.ts),
  [`src/client/index.ts`](src/client/index.ts)).
- The client part itself requests a refresh of a Project when `chat.hooks/v2`'s
  `onSandboxActivityHook` names it, and when `onThreadUpdateHook` delivers an
  event `tool.finished` of an `edit` or `write` call; any other update is
  ignored ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/refresh/tool-refresh.ts`](src/client/refresh/tool-refresh.ts)).
  Other bundles call `request` themselves.
- The Files view and each file tab register while mounted, always active
  ([`src/client/hooks/use-project-reads.ts`](src/client/hooks/use-project-reads.ts)).
  Their `refresh` rereads, in the bundle's query client, every query keyed
  `['files', projectId, …]`: requests within 250 ms share one read, a request
  during a read leaves one more after it, and a read in flight is not
  cancelled. A periodic refresh skips a read that failed or answered a state
  other than ready; any other refresh includes them
  ([`src/client/sandbox-store.ts`](src/client/sandbox-store.ts),
  [`packages/desktop/src/reads/refresh.ts`](../../../packages/desktop/src/reads/refresh.ts)).

### `files.open-file/v1` (client command, 1.0.0)

Registered with `commands/v1` by [`src/client/commands.ts`](src/client/commands.ts),
with the input `{ projectId: string; path: string }` (strict, `openFileInput`)
and no output. It opens, through `layout.tabs/v2.open`, the tab:

| Field     | Value                                                   |
| --------- | ------------------------------------------------------- |
| `id`      | `file:<path>`                                           |
| `title`   | the file's name                                         |
| `tooltip` | the whole path                                          |
| `tag`     | `files-file-view`, with the props `{ projectId, path }` |
| `iconTag` | `files-file-icon`                                       |
| `menu`    | one entry, `reveal-in-files`, "Reveal in Files"         |

Reveal in Files expands, in the open folders of the selected Project and the
tree's root (the selected Thread's working directory), every ancestor folder
of the file under that root; selects the Files view with
`layout.panel/v3.select('files')`; and focuses the tab with
`layout.tabs/v2.focus`, so the tree selects the file's row. A file outside the
root, or of another Project than the selected one, opens no folder. Each step
swallows its own failure ([`src/client/commands.ts`](src/client/commands.ts),
[`src/client/paths.ts`](src/client/paths.ts)).

### `files.decorations/v1` (declared, client, many)

Declared here as `FilesDecorations`, referenced as `FilesDecorationsV1`, for
other bundles to provide with the cardinality `many`; this bundle only
consumes it ([`src/contracts/index.ts`](src/contracts/index.ts)):

```ts
interface FilesDecorations {
  observe(
    scope: TreeScope,
    listener: (state: DecorationsObservation) => void,
    call?,
  ): Disposable;
}
interface DecorationsObservation {
  marks: { path: string; mark: FileMark }[]; // workspace-relative paths
  error?: string;
  fetching: boolean;
}
interface FileMark {
  description: string; // the row's accessible label and tooltip suffix
  count: number; // a directory's badge: marked entries below it
  tone?: string; // class names of the marked name and badge
  letter?: string; // a file badge's letter
  struck?: boolean; // whether a file's name is struck through
}
```

`observe` takes `[scope, listener]` as one tuple input
(`filesDecorationsMethods`); observing starts the provider's read, which runs
only while observed. How the Files view merges the answers is under
[Marks](#marks).

### Exports of `files/contracts`

From [`src/contracts/index.ts`](src/contracts/index.ts) and
[`src/contracts/reads.ts`](src/contracts/reads.ts):

| Name                                                                                                                                                                      | What it is                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Files`, `FilesV1`, `filesMethods`                                                                                                                                        | `files/v1`: interface, reference, method table                                                     |
| `DirectoryRead`, `TreeRead`, `DirectoriesInput`, `DirectoriesRead`, `DirectoryListingRead`, `ContentInput`, `ContentRead`, `CreateInput`, `CreateOutcome`, `LeaseOutcome` | The `files/v1` types; `LeaseOutcome` re-exported from `runtime/contracts`                          |
| `createInputSchema`, `createOutcomeSchema`, `DIRECTORIES_LIMIT`                                                                                                           | The create schemas and the most paths one `directories` call takes (1,000)                         |
| `FilesSandbox`, `FilesSandboxV1`, `filesSandboxMethods`, `TreeScope`, `TreeObservation`, `ReadState`, `ProjectTreeNode`                                                   | `files.sandbox/v1`                                                                                 |
| `FilesRefresh`, `FilesRefreshV1`, `filesRefreshMethods`, `ProjectReads`                                                                                                   | `files.refresh/v1`                                                                                 |
| `FilesDecorations`, `FilesDecorationsV1`, `filesDecorationsMethods`, `DecorationsObservation`, `FileMark`                                                                 | `files.decorations/v1`                                                                             |
| `OPEN_FILE_COMMAND`, `openFileInput`, `OpenFileInput`                                                                                                                     | `files.open-file/v1`: its id, input schema and type                                                |
| `ROOT_PATH`, `SANDBOX_ROOT`                                                                                                                                               | `''`, the workspace root as a relative path; `/workspace`, the sandbox mount                       |
| `workspacePath(cwd)`                                                                                                                                                      | The workspace-relative path of a sandbox-absolute path; the mount and any path outside it are `''` |
| `ProjectLeaseState`, `SandboxStatus`                                                                                                                                      | `missing`, `pending`, `expired`, `unavailable`; those plus `invalid_path` and `not_found`          |
| `sandboxNotice(status, retryAfterSeconds?)`                                                                                                                               | The sentence a surface shows for a `SandboxStatus`; see [Errors](#errors-and-failure-behavior)     |

[`src/contracts/reads.ts`](src/contracts/reads.ts) imports nothing at run
time.

## Contracts used

| Contract                 | Kind     | What for                                                                                                                                                                                                                            |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/v1`               | requires | `register` of the seven tools ([`src/host/index.ts`](src/host/index.ts))                                                                                                                                                            |
| `runtime.workspace/v1`   | requires | `cwd`, `setCwd` and `location` of the calling Thread ([`src/host/sandbox.ts`](src/host/sandbox.ts), [`src/host/tools/cwd.ts`](src/host/tools/cwd.ts), [runtime README](../../runtime/runtime/README.md))                            |
| `runtime.lease/v1`       | requires | `withLease` for every `files/v1` method; `describe`, `exec`, `readFile`, `readFileBytes` and `writeFile` for the tools ([`src/host/reads.ts`](src/host/reads.ts), [`src/host/sandbox.ts`](src/host/sandbox.ts))                     |
| `runtime.attachments/v1` | requires | `attach` keeps the image `view-image` reads; `ATTACHMENT_MAX_BYTES` and `attachmentReference` ([`src/host/tools/view-image.ts`](src/host/tools/view-image.ts))                                                                      |
| `ui/v1`                  | requires | `define` of the four elements ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                                        |
| `regions/v1`             | requires | `add` of the Files view to `shell.panel` ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                             |
| `commands/v1`            | requires | `register` of `files.open-file/v1`; the tree runs it through `execute` ([`src/client/commands.ts`](src/client/commands.ts), [`src/client/tree/files-tree.tsx`](src/client/tree/files-tree.tsx))                                     |
| `hooks/v1`               | requires | `whenAvailable` waits for `chat.hooks/v2` ([`src/client/index.ts`](src/client/index.ts))                                                                                                                                            |
| `workspace.selection/v1` | requires | `current()` and `subscribe` give the selected Project and Thread ids ([`src/client/api/selection.ts`](src/client/api/selection.ts), [workspace README](../../desktop/workspace/README.md))                                          |
| `runtime.records/v1`     | requires | `project`, `thread`, `threads`, `connection` and `subscribe` give their records ([`src/client/api/selection.ts`](src/client/api/selection.ts))                                                                                      |
| `layout.panel/v3`        | requires | `select('files')` on activation and from Reveal in Files ([`src/client/index.ts`](src/client/index.ts), [layout README](../../desktop/layout/README.md))                                                                            |
| `layout.tabs/v2`         | requires | `open` and `focus` of file tabs, `current()` and `subscribe` for the selected row; the tab `menu` of 2.0.0 ([`src/client/commands.ts`](src/client/commands.ts), [`src/client/tree/files-tree.tsx`](src/client/tree/files-tree.tsx)) |
| `files.decorations/v1`   | optional | Every provider's marks for the tree ([`src/client/hooks/use-decorations.ts`](src/client/hooks/use-decorations.ts))                                                                                                                  |
| `chat.hooks/v2`          | optional | `onSandboxActivityHook` and `onThreadUpdateHook` trigger refreshes ([`src/client/api/peers.ts`](src/client/api/peers.ts), [chat README](../../desktop/chat/README.md))                                                              |
| `chat.views/v1`          | optional | `registerToolRenderer` for `edit`, `write` and `view-image` ([`src/client/chat/views.ts`](src/client/chat/views.ts))                                                                                                                |

The client part does not import `chat/contracts` at run time: `chat.hooks/v2`
is a structural copy defined by contract id in
[`src/client/api/peers.ts`](src/client/api/peers.ts) (`onSandboxActivityHook`
with `{ projectId }`; `onThreadUpdateHook` with
`{ projectId, threadId, threadName, update }`, `update.kind` being `event` or
`updated`), and the `chat.views/v1` reference is built from its id in
[`src/client/chat/views.ts`](src/client/chat/views.ts); only types come from
`chat/contracts`. Without `chat` the bundle draws nothing in the conversation
and refreshes nothing after a tool call.

## Tools

The host part registers every tool always available, at a fixed global
position in the model's tool list ([`src/host/index.ts`](src/host/index.ts)).
Positions 500 and 700 are the `terminal` tool of
[`terminal`](../terminal/README.md) and the `web` tool of
[`web`](../web/README.md).

| Order | Tool         | File                                                           |
| ----- | ------------ | -------------------------------------------------------------- |
| 100   | `cwd`        | [`src/host/tools/cwd.ts`](src/host/tools/cwd.ts)               |
| 200   | `edit`       | [`src/host/tools/edit.ts`](src/host/tools/edit.ts)             |
| 300   | `find`       | [`src/host/tools/find.ts`](src/host/tools/find.ts)             |
| 400   | `grep`       | [`src/host/tools/grep.ts`](src/host/tools/grep.ts)             |
| 600   | `tree`       | [`src/host/tools/tree.ts`](src/host/tools/tree.ts)             |
| 800   | `write`      | [`src/host/tools/write.ts`](src/host/tools/write.ts)           |
| 850   | `view-image` | [`src/host/tools/view-image.ts`](src/host/tools/view-image.ts) |

Each tool runs in the calling prompt's Project sandbox, reached through
`runtime.lease/v1` with the call's scope; the lease's `exec` gets no abort
signal. A relative path resolves against the calling Thread's working
directory, read through `runtime.workspace/v1.cwd` at call time; an absolute
path is used as it is ([`src/host/sandbox.ts`](src/host/sandbox.ts)). Every
input is a strict object. `find`, `grep` and `tree` refuse a path outside the
workspace root; `edit`, `write` and `view-image` check no boundary of their
own and take whatever the lease's `readFile`, `writeFile` and `readFileBytes`
take.

### `cwd`

- Description: "Report this thread's working directory, or move it to a given
  path. A relative path resolves against the current directory, the way cd
  does. A move takes effect only when the path is a directory inside the
  workspace root, and every other tool resolves its relative paths against
  this directory. Move here as soon as the work moves into a repository or a
  subdirectory - after a clone, for instance - so the other tools run in it."
  ([`src/host/tools/cwd.ts`](src/host/tools/cwd.ts)).
- Input `{ path?: string }`. Output
  `{ cwd, status: 'reported' | 'set' | 'refused', reason?: 'outside' | 'missing' | 'not-directory', repositoryRoot, note? }`.
- A path absent or blank once trimmed reports; any other is trimmed and passed
  to `runtime.workspace/v1.setCwd`, whose refusal keeps the directory and
  names `reason`. Every outcome then reads `location()`, so `cwd` and
  `repositoryRoot` describe the directory after the call; a repository root
  adds `note`: "Remember to load the skills that match your task when working
  in a repository." [The `cwd` tool](../../../docs/features/cwd-tool.md)
  describes the flow.

### `edit`

- Description: "Edit a file using exact text replacement. Each edit's oldText
  must match a unique, non-overlapping region of the original file. If two
  changes affect the same block or nearby lines, merge them into one edit. A
  relative path resolves against the current working directory."
  ([`src/host/tools/edit.ts`](src/host/tools/edit.ts)).
- Input `{ path, edits: { oldText, newText }[] }`. Output
  `{ success, diff, first_changed_line?, error? }`.
- It reads the file, strips and keeps a byte order mark, and compares with
  line endings as `\n`. Each `oldText` and `newText` loses the trailing
  whitespace of each line and a final line break. When every `oldText` occurs
  in the file, the file is matched as it is; otherwise the whole file is
  matched and rewritten with the trailing whitespace of each line stripped and
  without its final line break.
- Each `oldText` must occur exactly once and the matched regions must not
  overlap; every edit applies to the original content. The file is written
  back with its byte order mark, and with `\r\n` when it held one.
- A failure writes nothing and answers `success: false`, `diff: ''` and one
  `error`, the first failure in this order: the read; an empty `edits`; then,
  edit by edit in input order, an empty `oldText` and an `oldText` equal to its
  `newText`; then, edit by edit, an `oldText` not found and one found more than
  once; then overlap; then a whole result equal to the file; then the write
  (`<path>` is the input's path and `<i>` an index of `edits`; the second form
  is used when there are several edits):
  - `File not found: <path>`, or `Failed to read file: <message>`;
  - `edits must contain at least one replacement.`;
  - `oldText must not be empty in <path>.` /
    `edits[<i>].oldText must not be empty in <path>.`;
  - when an `oldText` equals its `newText`:
    `No changes made to <path>. The replacement produced identical content.` /
    `No changes made by edits[<i>] in <path>. The replacement produced identical content.`;
  - `Could not find the exact text in <path>. The old text must match exactly including all whitespace and newlines.` /
    `Could not find edits[<i>] in <path>. The oldText must match exactly including all whitespace and newlines.`;
  - `Found <n> occurrences of the text in <path>. The text must be unique. Please provide more context.` /
    `Found <n> occurrences of edits[<i>] in <path>. Each oldText must be unique. Please provide more context.`;
  - `edits[<i>] and edits[<j>] overlap in <path>. Merge them into one edit.`;
  - when the whole result equals the file:
    `No changes made to <path>. The replacement produced identical content.`;
  - `Failed to write file: <message>`.
- `diff` holds the changed lines, each `<line> -<text>` or `<line> +<text>`
  with the number right-aligned, and up to three lines of context on each
  side; `first_changed_line` is the first line that differs.

### `write`

- Description: "Write content to a file. Creates the file if it doesn't
  exist, overwrites if it does. Automatically creates parent directories. A
  relative path resolves against the current working directory."
  ([`src/host/tools/write.ts`](src/host/tools/write.ts)).
- Input `{ path, content }`. Output `{ success, bytes_written, diff?, error? }`.
- It creates or overwrites the file through the lease's `writeFile`, which
  creates the parent directories. An empty `path` answers
  `Path must not be empty`, a failed write `Failed to write file: <message>`,
  each with `success: false` and `bytes_written: 0`.
- `bytes_written` is the content's UTF-8 length. `diff` is
  `Edited <path> (+<added> -<removed>)` followed by the changed lines against
  the earlier content (empty for a new file), with three lines of context.

### `find`

- Description: "Search for files by glob pattern. Returns matching file paths
  relative to the search directory. A relative path resolves against the
  current working directory. Respects .gitignore. Output is truncated to 1000
  results or 50KB (whichever is hit first)."
  ([`src/host/tools/find.ts`](src/host/tools/find.ts)).
- Input `{ pattern, path?, limit? }`. Output
  `{ results, total, truncated, error? }`.
- It lists, in sorted order, the [visible files](#workspace-visibility-rules)
  under `path` (the working directory by default) whose path relative to
  `path`, or whose name, matches the glob, as paths relative to `path`. In the
  glob, `**` matches anything, `*` anything but `/`, `?` one character but
  `/`; a `[` is refused.
- It stops at `limit` results (1,000 by default) or 50 KiB of output and sets
  `truncated`; `total` then counts the matches up to the first one left out.
- Errors, each with no results: `Path escapes workspace: <path>`,
  `Path not found: <path>`, and
  `Invalid glob pattern '<pattern>': unsupported character classes`, or
  `… unclosed character class` when no `]` follows the `[`. A path that is
  not a directory answers no results and no error.

### `grep`

- Description: "Search file contents for a pattern. Returns matching lines
  with file paths and line numbers. A relative path resolves against the
  current working directory. Respects .gitignore. Output is truncated to 100
  matches or 50KB (whichever is hit first). Long lines are truncated to 500
  chars." ([`src/host/tools/grep.ts`](src/host/tools/grep.ts)).
- Input `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }`.
  Output `{ matches, total, truncated, lines_truncated, error? }`, each match
  `{ file, line, text, context_before, context_after }`.
- `pattern` is a JavaScript regular expression (`i` with `ignoreCase`), or
  literal text with `literal: true`. `path` may name one file, then the only
  file searched; otherwise the [visible files](#workspace-visibility-rules)
  under it are searched. `file` is the path relative to `path`, or the file's
  name when `path` names a file. `glob`, with the glob rules of `find` (any
  `[` or `]` refused), filters on `file` or the file's name, and still
  filters the one file `path` names. A file that cannot be read is skipped.
  `context` lines are kept on each side.
- It stops at `limit` matches (100 by default, at least 1) or about 50 KiB and
  sets `truncated`; `total` is the number of matches returned. A line over 500
  characters is cut to 500 plus `... [truncated]`, which sets
  `lines_truncated`.
- Errors, each with no matches: `Path escapes workspace: <path>`,
  `Path not found: <path>`, `Invalid regex pattern: <message>`, and
  `Invalid glob pattern '<glob>': unsupported character classes`, or
  `… unclosed character class` when a `[` has no `]`.

### `tree`

- Description: "Display directory structure as an ASCII tree. Directories are
  listed first, then files, both sorted alphabetically. Respects .gitignore,
  ignores node_modules and \_\_pycache\_\_ unless a .gitignore negation brings
  them back, and excludes hidden files except .agents. A relative path
  resolves against the current working directory. Shows `depth` levels below
  the path (default 3); a directory at the last level shows how many entries
  it holds instead of its children, so call tree on it to look deeper."
  ([`src/host/tools/tree.ts`](src/host/tools/tree.ts)).
- Input `{ path?, exclude?: string[], depth?: positive integer }`. Output:
  text.
- It lists the tree below `path` through the
  [workspace's visibility rules](#workspace-visibility-rules), with `exclude`
  patterns, and prints the directory's absolute path, then one line per entry
  drawn with `|-- ` (`` `-- `` for the last entry), a directory's name ending
  in `/`, and a final line break. Children are indented with `|   ` under a
  non-last entry and four spaces under the last. It shows `depth` levels (3 by
  default); a non-empty directory at the last level reads
  `<name>/ (<n> entries not shown)`, with one hidden child
  `<name>/ (1 entry not shown)`, and an empty directory `<name>/ (empty)`.
- Errors, as the whole answer (`<path>` is the input's path, `.` when
  absent): `Error: <message>` for a path outside the workspace, with the
  sandbox's message; `Error: path not found: <path>`;
  `Error: path is not a directory: <path>`; the sandbox's message, as it is,
  for an invalid `exclude` pattern; and
  `Error: exclude pattern matches the root directory: <name>`.

### `view-image`

- Description: "Look at an image file in the workspace: a PNG, JPEG, WebP or
  GIF of at most 5 MiB. The image itself comes back with the result, so you
  see it, and the result's line shows it to the reader in the conversation. A
  relative path resolves against the current working directory." The size is
  `ATTACHMENT_MAX_BYTES` of `runtime/contracts`
  ([`src/host/tools/view-image.ts`](src/host/tools/view-image.ts)).
- Input `{ path }` (non-empty). Output: the attachment's reference line.
- It reads the file's bytes through the lease, keeps them as an attachment of
  the Project with `runtime.attachments/v1.attach`, and answers
  `attachmentReference(name, id)`. The tool declares
  `resultModalities: ['image']`, so the model receives the image with the
  result. The runtime refuses a file that is not a PNG, JPEG, WebP or GIF of
  at most 5 MiB, and that refusal is the tool's failure.

### Workspace visibility rules

- `tree` and every `files/v1` listing read through
  [`packages/sandbox/src/lib/files.ts`](../../../packages/sandbox/src/lib/files.ts):
  a path stays inside the workspace root; `.gitignore` files apply, with
  negation; `node_modules/` and `__pycache__/` are ignored unless a negation
  shows them again; hidden entries are left out except `.agents`; `.git` is
  never listed; directories come first, then files, each sorted by name with
  `Intl.Collator(undefined, { sensitivity: 'accent' })`, ties broken by path
  ([sandbox README](../../../packages/sandbox/README.md)).
- `find` and `grep` read with
  [`src/host/tools/visible-files.ts`](src/host/tools/visible-files.ts): every
  file `find` lists under the searched directory, with `.git` and
  `node_modules` pruned, minus those a `.gitignore` inside that directory
  hides (on the file or a directory above it), the last matching rule winning
  so a negation reopens. Hidden files are searched. The filter yields to the
  event loop every 2,000 files.

## Skills

[`src/skills/`](src/skills) holds one skill per folder,
`<NN>-<name>/SKILL.md`, whose YAML frontmatter has `name`, `description`,
`order` and, optionally, `alwaysAvailable` and `allowed-tools`. `order` is the
skill's global position in the system prompt, mirrored by the folder's
two-digit prefix; position 1200 is the `web-research` skill of
[`web`](../web/README.md). The build validates every skill
([`packages/bundle/src/build/cli.ts`](../../../packages/bundle/src/build/cli.ts));
the host SDK registers them from the bundle's own process after `activate` (`registerBundleSkills`, [packages/bundle/src/sdk/host/skills.ts](../../../packages/bundle/src/sdk/host/skills.ts)), reading them through `context.assets`, so `host.assets` lists `src/skills/*/SKILL.md`; a skill that cannot be registered is skipped and logged (`skill not registered`). `allowed-tools` is a run-time reference for the model: `skills/v1` 1.3.0 stores it as given and does not check it against `tools/v1`.

| Order | Skill                         | Always available | Allowed tools                               |
| ----- | ----------------------------- | ---------------- | ------------------------------------------- |
| 100   | `goal-directed-tool-use`      | yes              | —                                           |
| 200   | `workspace-discovery`         | no               | `tree`, `find`                              |
| 300   | `content-search`              | no               | `grep`, `find`                              |
| 400   | `focused-file-inspection`     | no               | `terminal`                                  |
| 500   | `dependency-tracing`          | no               | `grep`, `find`, `tree`, `terminal`          |
| 600   | `exact-text-editing`          | no               | `edit`, `grep`, `terminal`                  |
| 700   | `whole-file-writing`          | no               | `find`, `terminal`, `write`                 |
| 800   | `multi-file-consistency`      | no               | `find`, `grep`, `edit`, `write`, `terminal` |
| 900   | `shell-command-execution`     | no               | `terminal`                                  |
| 1000  | `failure-diagnosis`           | no               | `terminal`, `grep`, `find`                  |
| 1100  | `change-validation`           | no               | `terminal`, `grep`, `find`                  |
| 1300  | `evidence-grounded-synthesis` | no               | `grep`, `terminal`, `web`                   |

## The Files view

`files-tree` is the region item `files` of `shell.panel`, with order 100, the
label `Files` and the icon element `files-file-icon` (a file glyph); its rows
render inside the sidebar scope of `desktop/ui/sidebar`
([`src/client/index.ts`](src/client/index.ts),
[`src/client/elements.tsx`](src/client/elements.tsx)). The view
([`src/client/tree/files-tree.tsx`](src/client/tree/files-tree.tsx)):

- reads the selected Project id and the selected Thread's working directory
  from `workspace.selection/v1` and `runtime.records/v1`, renders nothing
  until both are served, and observes the tree of that Project rooted at that
  directory through the sandbox store;
- shows `No project selected` with `Select a project to see its sandbox.`
  with no Project; skeleton rows announced as `Loading files` while the first
  read runs, or nothing when that read failed; `No files to show` with
  `sandboxNotice` of a state that is not ready; and `No files` with
  `This directory is empty.` with an empty root;
- draws the tree with `FileTree` of `desktop/ui/panels`, scrolling both ways;
  a file row runs `files.open-file/v1`, a folder row toggles it in the open
  folders, an open folder not read yet shows a loading line, and the row of
  the current `file:` tab is the selected one;
- shows one read toast, the id `layout-panel-read` shared by the panel's
  views, with the tree's error, else the marks' error, whose retry requests a
  refresh of the Project.

The open folders are kept per Project and root (the key
`JSON.stringify([projectId, root])`), apart from the read, so leaving a Thread
and coming back keeps them open
([`src/client/stores/expansion.ts`](src/client/stores/expansion.ts)).

### Marks

The view observes every provider of `files.decorations/v1` with
`{ projectId, cwd }` and draws their merge: for a path two providers mark, the
mark of the provider whose bundle id is smaller by code unit wins; `error` is
the first provider error in bundle-id order; `fetching` is whether any
provider fetches. Marks are keyed by path, so a folder never read carries
them. With no provider no row is marked
([`src/client/hooks/use-decorations.ts`](src/client/hooks/use-decorations.ts),
[`src/client/tree/decorations.ts`](src/client/tree/decorations.ts)).

### Row menus

- A file row's menu holds "Copy relative path", which writes the path relative
  to the tree's root to the clipboard
  ([`src/client/tree/files-tree.tsx`](src/client/tree/files-tree.tsx),
  [`src/client/paths.ts`](src/client/paths.ts)).
- A folder row's menu holds "New file" and "New folder". Each opens the folder
  and shows an inline name row as its first child; a new root or Project
  closes it. Enter sends the trimmed name to `files/v1.createFile` or
  `createDirectory`, and an empty name cancels; Escape or a blur cancels,
  except while the call runs, when the field is read-only. `created` closes
  the row and requests a refresh of the Project; any other answer shows its
  text under the row and keeps the typed name
  ([`src/client/tree/pending-entry.tsx`](src/client/tree/pending-entry.tsx),
  [`src/client/api/writes.ts`](src/client/api/writes.ts)):

| Answer                   | Text                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `refused` `exists`       | `<name> already exists.`                                                      |
| `refused` `invalid-name` | `A name cannot contain / or \, cannot be . or .., and has at most 255 bytes.` |
| `refused` `outside`      | `This folder is outside the Project.`                                         |
| `refused` `no-directory` | `This folder no longer exists.`                                               |
| `failed`                 | the command's message                                                         |
| lease `pending`          | `The Project is starting. Try again in a moment.`                             |
| lease `unavailable`      | `The Project is unavailable.`                                                 |
| lease `expired`          | `The Project's sandbox expired. Reopen the Project.`                          |
| lease `missing`          | `The Project no longer exists.`                                               |
| the call throws          | `Could not create <name>.`                                                    |

New file and New folder are the only workspace writes of the client part.

## The file tab

`files-file-view` takes the props `projectId` and `path`, renders nothing
without both, and shares the bundle's query client
([`src/client/elements.tsx`](src/client/elements.tsx),
[`src/client/file/file-view.tsx`](src/client/file/file-view.tsx)):

- It reads the file with `files/v1.content` as text, cached under
  `['files', projectId, 'file', path]`, and registers with the refresh
  coordinator while mounted.
- Until the first answer it shows twelve skeleton lines; a later read keeps
  the text on screen. A file the sandbox cannot give shows
  `This file cannot be shown` with `sandboxNotice` of its state. A binary
  file shows `This is a binary file, so its contents are not shown.`; a
  truncated one shows its first part and
  `This file is larger than the read limit, so only its first part is shown.`
  ([`src/client/reads/state.ts`](src/client/reads/state.ts)).
- The text is drawn by `CodeView` of `desktop/ui/code`, in the language
  `fileLanguage(path)` names. A failed read is the tab's own toast with a
  retry. The footer shows the path, and `Updating…` while a read runs.

## In the conversation

While `chat.views/v1` is served the client registers
([`src/client/chat/views.ts`](src/client/chat/views.ts)):

| Tool         | Drawing                                        |
| ------------ | ---------------------------------------------- |
| `edit`       | `files-edit-call`, standalone, open by default |
| `write`      | `files-edit-call`, standalone, open by default |
| `view-image` | the chat's generic row, open by default        |

`files-edit-call` takes the prop `view` (the chat's `ChatToolView`) and draws
one collapsible block: `Editing` while the call runs, `Failed to edit` when it
failed or answered `success: false`, else `Edited`; the file's name; the
`+added / −removed` counts, shown only when one is above 0 (from the
`Edited … (+N -M)` header when the result has one, else counted); and the
numbered diff, parsed from the result's `diff` or, without one, built from the
input's edits or content. The first 16 diff lines show, then
`⋯ Show <n> more lines` (`line` for one), which reads `⋯ Show less` once
open. A failure shows the error notice
with the fallback code `tool_failed`. Opening or closing the block dispatches
`chat-block-chosen` ([`src/client/chat/edit-call.tsx`](src/client/chat/edit-call.tsx),
[`src/client/chat/edit-tool.ts`](src/client/chat/edit-tool.ts)).

## Data, side effects and configuration

- The bundle stores nothing. The window keeps, per activation, one TanStack
  query client whose defaults retry and refetch nothing and are stale at once
  (each read sets its own retry, under
  [Errors](#errors-and-failure-behavior)), with the keys
  `['files', projectId, 'tree', cwd]` and `['files', projectId, 'file', path]`,
  and the open folders per Project and root; deactivation clears both
  ([`src/client/sandbox-store.ts`](src/client/sandbox-store.ts),
  [`src/client/stores/expansion.ts`](src/client/stores/expansion.ts)).
- Side effects: the tools `edit` and `write` write the sandbox, `cwd` moves
  the Thread's working directory, `view-image` adds an attachment to the
  Project; `createFile` and `createDirectory` make workspace entries; the
  client writes to the clipboard and opens and focuses tabs.
- There is no configuration and no setting.

## Limits

| Limit                               | Value              | Where                                                                                     |
| ----------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `content` as text                   | 262,144 bytes      | [`src/host/reads.ts`](src/host/reads.ts)                                                  |
| `content` as base64                 | 4,194,304 bytes    | [`src/host/reads.ts`](src/host/reads.ts)                                                  |
| Paths of one `directories` call     | 1 to 1,000         | [`src/contracts/index.ts`](src/contracts/index.ts)                                        |
| Name of a created entry             | 255 UTF-8 bytes    | [`src/host/writes.ts`](src/host/writes.ts)                                                |
| `find` results                      | 1,000 or 50 KiB    | [`src/host/tools/find.ts`](src/host/tools/find.ts)                                        |
| `grep` matches; line length         | 100 or 50 KiB; 500 | [`src/host/tools/grep.ts`](src/host/tools/grep.ts)                                        |
| `tree` depth by default             | 3                  | [`src/host/tools/tree.ts`](src/host/tools/tree.ts)                                        |
| `view-image` image                  | 5 MiB              | [`src/host/tools/view-image.ts`](src/host/tools/view-image.ts)                            |
| Window Project id; path             | 200; 4,096 chars   | [`src/client/api/reads.ts`](src/client/api/reads.ts)                                      |
| Refresh coalescing                  | 250 ms             | [`packages/desktop/src/reads/refresh.ts`](../../../packages/desktop/src/reads/refresh.ts) |
| Refresh poll                        | 15 s               | [`src/client/refresh/coordinator.ts`](src/client/refresh/coordinator.ts)                  |
| Edit block lines before "Show more" | 16                 | [`src/client/chat/edit-call.tsx`](src/client/chat/edit-call.tsx)                          |

## Errors and failure behavior

- `files/v1` answers every expected failure as data: a lease state, a
  listing or content refusal, or a create refusal; it throws only on a
  contract error ([`src/host/reads.ts`](src/host/reads.ts)).
- The window checks before each read that the Project id is a string of 1 to
  200 characters without NUL, and that a path does not start with `/`, has no
  `..` segment and no NUL, and is at most 4,096 characters, and refuses
  otherwise with `The item identifier is invalid.` or
  `The workspace path is invalid.`. A `directories` read drops duplicate
  paths before the call and refuses, with `The workspace path is invalid.`,
  none or more than 1,000 of them; a `content` read of the root answers
  `invalid_path` without a call. It turns
  a lease state into data (`pending` with `retryAfterSeconds: 1`), a refusal
  into `not_found` or else `invalid_path`, a malformed answer into
  `Doric returned an invalid response.`, a contract error `unavailable`,
  `disconnected` or `generation_lost` into `Doric backend is unavailable.`,
  `invalid_output` into `Doric returned an invalid response.`, and any other
  failure into `The request could not be completed.`
  ([`src/client/api/reads.ts`](src/client/api/reads.ts)). The create calls
  pass their outcome through unchanged
  ([`src/client/api/writes.ts`](src/client/api/writes.ts)).
- A failed tree or file read is retried three times, after 1, 2 and 4
  seconds; a read that answers `pending` is read again after
  `retryAfterSeconds` (at least 1 s, 3 s without a hint); any other answer
  waits for a refresh
  ([`src/client/sandbox-store.ts`](src/client/sandbox-store.ts),
  [`packages/desktop/src/reads/read-policy.ts`](../../../packages/desktop/src/reads/read-policy.ts)).
- `sandboxNotice` answers ([`src/contracts/reads.ts`](src/contracts/reads.ts)):

| Status         | Sentence                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `pending`      | `The sandbox is still being prepared.`, or with a hint `…; the host suggests trying again in <n> seconds.` |
| `expired`      | `The sandbox lease for this Project expired, so its files are no longer readable.`                         |
| `unavailable`  | `The sandbox is unavailable, so this Project has no files to show.`                                        |
| `missing`      | `This Project has no sandbox yet, so it has no files to show.`                                             |
| `invalid_path` | `That path is not inside the workspace.`                                                                   |
| `not_found`    | `That path is no longer in the workspace.`                                                                 |

- The tools answer their failures in their output (`error`, `success: false`
  or an error line), except `view-image`, whose read or attachment refusal is
  the call's failure. Activation steps that reach an absent layout panel,
  and every Reveal in Files step, swallow their failure
  ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/commands.ts`](src/client/commands.ts)).

## Build and test

```console
npx nx run bundle-files:build
npx nx run bundle-files:typecheck
npx nx run bundle-files:test
```

The build compiles the parts, validates the manifest and the skills, copies
the skills and dry-activates the host part, writing
`bundles/features/files/dist` ([`project.json`](project.json),
[`packages/bundle/src/build/cli.ts`](../../../packages/bundle/src/build/cli.ts));
`doric-host:build-bundles` stages it into `app/backend/doric-host/dist/bundles`
([`app/backend/doric-host/project.json`](../../../app/backend/doric-host/project.json)).
The `test` target builds the bundle, compiles `tests/` and `tests/client/` to
`dist-tests` and runs them with `node --test` ([`project.json`](project.json)).

The tests live in [`tests/`](tests): one file per tool, over a local
directory posing as the sandbox ([`tests/fake-sandbox.ts`](tests/fake-sandbox.ts))
and fake runtime services ([`tests/support/services.ts`](tests/support/services.ts));
the host reads and writes (`reads.test.ts`, `write-entry.test.ts`); the
window's DOM-free logic (coordinator, sandbox store, reads, decorations, open
file); the manifest, the activation order, the skills and the stylesheet; the
generated code's imports (`generated-imports.test.ts`); and,
in [`tests/client/`](tests/client), the rendered views under `happy-dom`
through [`tests/client/support/render.ts`](tests/client/support/render.ts).
[`stories/`](stories) holds the views' stories over fakes in
[`stories/support/`](stories/support).
