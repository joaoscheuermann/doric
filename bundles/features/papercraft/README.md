# papercraft

`papercraft` lets an agent show a user-interface change instead of describing
it. The agent writes an [OpenUI Lang](../openui/README.md) program in a
`papercraft` fence of its answer; the conversation draws it as a live canvas
node with the Project's own components, in a sandboxed frame. The reader
clicks the element they mean and leaves a comment pinned to it; the comments
go to the agent with the next prompt, and the agent answers with a patch: a
fence with the same identity holding only the statements that change.

The bundle has a host part (the skill, the repository libraries, the builds of
`Export`, the working-directory event), a desktop part (the verified module
cache, the window snapshot, the canvas window command and the comment flush), a
client part (the fence node, the canvas window and the program frame) and a
runner that the host copies into the Project's sandbox.

The flow across bundles is described in the feature docs
[papercraft](../../../docs/features/papercraft.md),
[comments](../../../docs/features/comments.md),
[skills](../../../docs/features/skills.md),
[diagrams in OpenUI fences](../../../docs/features/openui-diagrams.md) and
[Projects and Threads](../../../docs/features/projects-and-threads.md). How
bundles are built and loaded is described in
[`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json) declares:

- `id` `papercraft`, `version` `2.1.2`, `engines.doric` `^1.0.0`.
- `provides`: `papercraft.programs/v1@1.0.0`, `papercraft.cache/v1@1.0.0`,
  `papercraft.cwd/v1@1.0.0` (an event), `papercraft.open-canvas/v2@2.0.0`,
  `papercraft.snapshot/v1@1.0.0`, and the client commands
  `papercraft.select/v1`, `papercraft.comment/v1`, `papercraft.pan/v1`,
  `papercraft.isolate/v1`, `papercraft.show-all/v1`, `papercraft.zoom-out/v1`,
  `papercraft.zoom-reset/v1`, `papercraft.zoom-in/v1`, `papercraft.zoom-fit/v1`,
  `papercraft.select-revision/v1` and `papercraft.send/v1`, each `@1.0.0`.
- `requires`: `files/v1@^1.1.0`, `runtime.lease/v1@^1.1.0`,
  `comments/v1@^1.0.0`, `ui/v1@^1.0.0`, `navigation/v1@^1.0.0`,
  `commands/v1@^1.0.0`, `menus/v1@^1.0.0`, `hooks/v1@^1.0.0`,
  `windows/v1@^1.0.0`, `openui.programs/v1@^1.0.0`, `chat.views/v1@^1.1.0`,
  `runtime.threads/v1@^1.5.0`, `runtime.hooks/v1@^1.2.0`, `skills/v1@^1.1.0`
  and `events/v1@^1.0.0`.
- `optional`: `chat.composer/v1`, `chat.send/v1`, and the events
  `comments.added/v1` and `comments.resolved/v1`, which the client reads off a
  Thread's log.
- `desktopScope`: `papercraft.programs/v1` and `papercraft.cache/v1` are called
  from a window with the keys `projectId` and `threadId`.

The package ([`package.json`](package.json)) exports only `./contracts` and
`./package.json`. It depends on `@openuidev/lang-core` 1.0.2,
`@openuidev/react-lang` 1.0.2 and `@openuidev/react-ui` 0.18.1 (exact
versions), `esbuild` 0.28.2, `tailwindcss` and `@tailwindcss/oxide` 4.3.3,
`jdenticon`, `lucide-react`, React 19, `zod` 4 and the workspace packages
`bundle`, `desktop`, `openui` and `runtime`.

## Parts and build output

| Part      | Source                                                       | Built as                                                    | What it does                                                                                                            |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| contracts | [`src/contracts/`](src/contracts/index.ts)                   | `dist/contracts/`, imported as `papercraft/contracts`       | Refs, schemas and method specs of the provided contracts, the event, shared names, structural copies of used contracts. |
| host      | [`src/host/`](src/host/index.ts)                             | `dist/host/`, with `skills/papercraft.md` copied beside it  | The skill, the two runtime hooks, `papercraft.programs/v1`, the event registration, the `Export` compiler.              |
| desktop   | [`src/desktop/`](src/desktop/index.ts)                       | `dist/desktop/`                                             | `papercraft.open-canvas/v2`, `papercraft.cache/v1`, `papercraft.snapshot/v1`, the `papercraft-program` flush.           |
| client    | [`src/client/index.ts`](src/client/index.ts)                 | `dist/client/index.js`, `dist/client/styles.css`            | `<papercraft-fence>`, `<papercraft-canvas>`, the canvas route, the projectors, the commands and keybindings.            |
| frame     | [`src/client/frames/openui.ts`](src/client/frames/openui.ts) | `dist/client/frames/openui.js`                              | The program runtime every fence's iframe loads.                                                                         |
| runner    | [`src/sandbox/main.ts`](src/sandbox/main.ts)                 | `dist/sandbox/runner.mjs` (one esbuild bundle, Node 22 ESM) | The library and bundle jobs the host runs in the Project's sandbox.                                                     |

The `build` target of [`project.json`](project.json) runs `tsc` over the three
`tsconfig` files, the bundle build of `packages/bundle`, and esbuild for the
runner. The build of `packages/bundle` turns each `src/client/frames/<name>.ts`
into `client/frames/<name>.js`
([`parts.ts`](../../../packages/bundle/src/build/parts.ts)).

`src/sandbox/` and the host modules it imports
([`bundle.ts`](src/host/bundle.ts), [`harness.ts`](src/host/harness.ts),
[`entry.ts`](src/host/entry.ts), [`paths.ts`](src/host/paths.ts)) run both on
the host and, bundled into the runner, inside the sandbox: they read Project
files only through a `SourceReader` handed to them.

## Contracts provided

All are exported from `papercraft/contracts`
([`src/contracts/index.ts`](src/contracts/index.ts)).

### `papercraft.programs/v1` 1.0.0 — libraries, exports and module bytes

Provided by the host, every method exposed to the desktop
([`src/contracts/programs.ts`](src/contracts/programs.ts),
[`src/host/programs.ts`](src/host/programs.ts)). Ref: `PapercraftProgramsV1`;
method specs: `papercraftProgramsMethods`. The provider is registered by
`createLibraryHooks`, which ignores a `provider_conflict` from a second set of
hooks over the same services ([`src/host/library.ts`](src/host/library.ts)).

```ts
interface PapercraftPrograms {
  library(
    input: { turnSequence: number },
    call?: CallArg,
  ): Promise<LibraryAnswer>;
  export(
    input: { path: string; name?: string },
    call?: CallArg,
  ): Promise<ExportAnswer>;
  read(input: { dir: string }, call?: CallArg): Promise<ModuleEntries>;
}

interface ModuleRef {
  dir: string; // SHA-256 of the files' `<path>:<sha256>` lines, sorted by path, joined by \n
  files: { path: string; sha256: string }[]; // index.js, index.css?, assets/<sha256>.<ext>
}

type LibraryAnswer =
  | { status: 'none' }
  | { status: 'ready'; root: string; module: ModuleRef }
  | { status: 'failed'; root?: string; error: string }; // error ≤ 4,096 chars

type ExportAnswer =
  | { status: 'ready'; module: ModuleRef }
  | { status: 'failed'; error: string };

interface ModuleEntries {
  entries: {
    path: string /* <dir>/<file> */;
    sha256: string;
    base64: string;
  }[];
}
```

- Every input schema is strict; `turnSequence` is an integer from 0, `path`,
  `name` and `dir` are non-empty strings.
- Every method needs `projectId` and `threadId` in the call's scope, else it
  rejects with `invalid_scope` ("papercraft.programs/v1 needs a Project and
  Thread scope.").
- `library` answers `none` when no `papercraft.cwd/v1` event of the Thread lies
  below `turnSequence`; otherwise it answers the library of that event's `cwd`
  ([Repository libraries](#repository-libraries)). It never rejects for a
  library problem.
- `export` builds one export or story of a workspace file
  ([Export builds](#export-builds)). A path that leaves the Project answers
  `failed` with "The path leaves the Project"; a build error answers `failed`
  with its message, cut to 4,096 characters.
- `read` answers the bytes of the module whose `dir` the host memo holds for
  the call's Project, and rejects with `not_found` ("No module <dir> is in the
  host memo.") otherwise; the caller then asks `library` or `export` again,
  once.

### `papercraft.cache/v1` 1.0.0 — the verified module cache

Provided by the desktop part, exposed to the desktop
([`src/contracts/cache.ts`](src/contracts/cache.ts),
[`src/desktop/cache.ts`](src/desktop/cache.ts)). Ref: `PapercraftCacheV1`;
method specs: `papercraftCacheMethods`.

```ts
interface PapercraftCache {
  ensure(
    input: { entries: ModuleCacheEntry[] },
    call?: CallArg,
  ): Promise<ModuleCacheEnsureResult>;
}
interface ModuleCacheEntry {
  path: string /* <dir>/<file> */;
  sha256: string /* 64 lowercase hex */;
  base64: string;
}
interface ModuleCacheEnsureResult {
  written: string[]; // verified and written now
  kept: string[]; // already cached with the declared hash
  failed: { path: string; message: string }[]; // bad path, hash mismatch, failed write
}
const MODULES_URL = 'doric://app/papercraft-modules/';
```

- The cache root is the bundle's `doric.cache/v1` directory, which the desktop
  app places at `userData/papercraft/` and serves under
  `doric://app/papercraft-modules/<dir>/<file>`
  ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The directory
  is read at the first call ([`src/desktop/index.ts`](src/desktop/index.ts)).
- An entry's path must be `<dir>/<file…>` with `<dir>` 64 lowercase hex and no
  empty, `.`, `..`, NUL or backslash segment, and must stay inside the root;
  else it is listed in `failed` ("module entry is not <dir>/<file> of this
  cache"). Bytes whose SHA-256 differs from `sha256` fail ("module entry hash
  mismatch"). A file already present with that hash is `kept`. Every other
  file is written to `<root>/.tmp/`, synced, and renamed into place, so no
  partial file is served.
- Each `<dir>/` written or kept gets a fresh modification time. The first
  `ensure` of each cache object (one per desktop app session) first cuts the
  root back when it holds more than 256 MiB, deleting whole `<dir>/` folders
  oldest first until at most 128 MiB remain; every call awaits that cut-back.
- The call ignores its scope. It rejects with `invalid_input` for an input
  that does not parse, and with the error of `doric.cache/v1.directory` when
  the cache directory cannot be read; that rejected directory read is kept,
  so every later call of the desktop session rejects the same way
  ([`src/desktop/index.ts`](src/desktop/index.ts)).

### `papercraft.snapshot/v1` 1.0.0 — a window's capture of itself

Provided by the desktop part, exposed to the desktop
([`src/contracts/index.ts`](src/contracts/index.ts),
[`src/desktop/snapshot.ts`](src/desktop/snapshot.ts)). Ref:
`PapercraftSnapshotV1`; method specs: `papercraftSnapshotMethods`.

```ts
interface PapercraftSnapshot {
  capture(input: { rect: SnapshotRect }, call?: CallArg): Promise<Snapshot>;
}
interface SnapshotRect {
  x: number /* ≥ 0 */;
  y: number /* ≥ 0 */;
  width: number;
  height: number;
} // CSS px, sides in (0, 4096]
interface Snapshot {
  png: string /* base64 */;
  width: number;
  height: number /* device px */;
  scale: number;
}
const SNAPSHOT_MAX_SIDE = 4096;
```

The window captured is the one in the call's window scope key, never an input.
A call without one rejects with `unavailable` ("Only a window captures itself,
and this call did not come from one."). The capture is the platform's
`doric.windows/v1.capture`; its contract errors pass through (`not_found` for a
closed window, `invalid_input` for a rectangle outside the viewport), and any
other failure becomes `unavailable` ("Window \"<key>\" could not be
captured.").

### `papercraft.open-canvas/v2` 2.0.0 — the canvas window

A desktop command ([`src/desktop/commands.ts`](src/desktop/commands.ts)). Its
strict input is `{ projectId: string; threadId: string; identity: string }`,
each non-empty. It opens or focuses, through `windows/v1.open`, the path
window keyed `program:<threadId>/<identity>` at
`/papercraft/<projectId>/<threadId>/<identity>` (each segment URI-encoded) with
the integrated title bar (`{ titleBar: 'integrated' }`). `canvasPathOf` and
`CANVAS_ROUTE` (`/papercraft/:projectId/:threadId/:identity`) are exported
from the contracts.

### The canvas commands

Client commands registered from
[`src/client/commands.ts`](src/client/commands.ts). Each takes the strict input
`{ canvasId?: string; revision?: number }` and acts on the canvas `canvasId`
names, else on the canvas last touched in the window
([`src/client/canvas-registry.ts`](src/client/canvas-registry.ts)); with no
canvas it does nothing.

| Command                         | Effect                                     | Keybinding        |
| ------------------------------- | ------------------------------------------ | ----------------- |
| `papercraft.select/v1`          | Arms the select tool                       | `V`               |
| `papercraft.comment/v1`         | Arms the comment tool                      | `C`               |
| `papercraft.pan/v1`             | Arms the pan tool                          | `H`               |
| `papercraft.isolate/v1`         | Shows only the selected element            | `I`               |
| `papercraft.show-all/v1`        | Shows every element again                  | `Shift+I`         |
| `papercraft.zoom-out/v1`        | Zooms out                                  | `CmdOrCtrl+-`     |
| `papercraft.zoom-reset/v1`      | Zooms to 100%                              | `CmdOrCtrl+0`     |
| `papercraft.zoom-in/v1`         | Zooms in                                   | `CmdOrCtrl+=`     |
| `papercraft.zoom-fit/v1`        | Fits the content                           | `Shift+1`         |
| `papercraft.select-revision/v1` | Shows `revision`, when given               | —                 |
| `papercraft.send/v1`            | Confirms the open note and sends the stack | `CmdOrCtrl+Enter` |

The keybindings are added through `menus/v1.addKeybinding`, each with
`when: { path: CANVAS_ROUTE }`, so they apply only in the canvas window
([`src/client/index.ts`](src/client/index.ts)). `PAPERCRAFT_KEYBINDINGS`
holds each command, key and label. The canvas's visible text is Portuguese:
the command labels, tooltips and `aria-label`s (`Selecionar`, `Comentar`,
`Mão`, …), the header's buttons, the thread menus, the placeholders
(`Adicionar comentário`, `Responder…`), the tree's label `estrutura`, and the
author name `você` of a comment without an author
([`src/contracts/index.ts`](src/contracts/index.ts),
[`src/client/surface/command-toolbar.tsx`](src/client/surface/command-toolbar.tsx),
[`src/client/surface/preview-header.tsx`](src/client/surface/preview-header.tsx),
[`src/client/surface/thread-popover.tsx`](src/client/surface/thread-popover.tsx),
[`src/client/surface/pins-layer.tsx`](src/client/surface/pins-layer.tsx),
[`src/client/surface/tree-panel.tsx`](src/client/surface/tree-panel.tsx),
[`src/client/surface/avatar.tsx`](src/client/surface/avatar.tsx)).

### `papercraft.cwd/v1` 1.0.0 — the Thread's working directory (event)

Defined with `defineEvent`; payload `{ cwd: string }` (non-empty, strict)
([`src/contracts/cwd.ts`](src/contracts/cwd.ts)). The host registers it with
`events/v1` and appends it ([Repository libraries](#repository-libraries)); the
client registers a projector that claims it and draws nothing
([`src/client/cwd-projector.ts`](src/client/cwd-projector.ts)).

### Other exports of `papercraft/contracts`

- `PROGRAM_TARGET_KIND` and `PROGRAM_COMMENT_KIND`, both
  `'papercraft-program'`: the comment target kind and the composer item kind.
- `PreviewItemData`, the `data` of a composer item:
  `{ target: CommentTarget; pin?: number; inReplyTo?: string; refs?: { title?: string; source?: string }; point?: { x: number; y: number } }`.
- `PAPERCRAFT_CANVAS_TAG` (`'papercraft-canvas'`), `PreviewScope`
  (`{ projectId; threadId? }`) with `callScopeOf`, `PreviewTool`
  (`'select' | 'comment' | 'pan'`), `RevisionReading`, and the command ids
  above as constants (`OPEN_CANVAS_COMMAND`, `SEND_COMMAND`, …).
- Structural copies, so that the bundle imports no `files`, `comments` or
  `chat` package and its client and desktop parts no `runtime` package
  (the host reads `files/v1` through its copy; the client reads
  `runtime.threads/v1` through its copy): `files/v1` (`FilesV1`),
  `comments/v1` (`CommentsV1`, with
  `commentAnchorSchema`, `commentTargetSchema`, `commentSchema`,
  `CommentAddInput`), the `watchThread` of `runtime.threads/v1`
  (`RuntimeThreadsV1`), and from [`src/contracts/chat.ts`](src/contracts/chat.ts)
  `chat.views/v1`, `chat.composer/v1`, `chat.send/v1`, `CHAT_COMMENT_LINE_TAG`
  (`'chat-comment-line'`) and the DOM events `doric:comment-thread-open` and
  `doric:prompt-send`. The ids and shapes are their owners'.

## Contracts used

| Contract                             | Part            | What for                                                                                  |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| `skills/v1`                          | host            | Registers the `papercraft` skill.                                                         |
| `events/v1`                          | host            | Registers and appends `papercraft.cwd/v1`.                                                |
| `hooks/v1`, `runtime.hooks/v1`       | host            | `onPromptStartedHook` and `onThreadCwdChangedHook`.                                       |
| `runtime.threads/v1`                 | host, client    | `threadEvents` (bindings), `instruct` (library instruct); `watchThread` (comment events). |
| `runtime.lease/v1`                   | host            | `withLease` runs runner jobs on the Project's current sandbox; it never acquires one.     |
| `files/v1`                           | host            | Reads Project sources, stylesheets and their `url()` assets, and probes `.git`.           |
| `comments/v1`                        | client          | `list` of the program comments, `resolve` of a thread.                                    |
| `openui.programs/v1`                 | client          | `reportErrors` of a drawn fence's errors, tag `papercraft`.                               |
| `chat.views/v1`                      | client          | `registerFenceRenderer`, `registerProjector`, `watchFences` (canvas window).              |
| `chat.composer/v1` (optional)        | client, desktop | Drafts in the Thread's stack; `registerFlush` of the `papercraft-program` kind.           |
| `chat.send/v1` (optional)            | client          | The canvas window's send.                                                                 |
| `ui/v1`, `navigation/v1`             | client          | Defines the elements; registers the canvas route.                                         |
| `commands/v1`                        | client, desktop | Registers the canvas commands (client) and `papercraft.open-canvas/v2` (desktop).         |
| `menus/v1`                           | client          | Adds the keybindings.                                                                     |
| `windows/v1`                         | desktop         | Opens the canvas window.                                                                  |
| `doric.cache/v1`, `doric.windows/v1` | desktop         | The cache directory; the window capture.                                                  |

The host takes `RuntimeLeaseV1`, `RuntimeHooksV1`, `RuntimeThreadsV1` and the
types `PromptStarted`, `CwdChanged` and `ThreadEvent` from `runtime/contracts`
([`src/host/sandbox.ts`](src/host/sandbox.ts),
[`src/host/index.ts`](src/host/index.ts),
[`src/host/library.ts`](src/host/library.ts)). The client imports from
`openui/contracts` the fold of a Thread's fences into programs
(`createProgramFolds`), the error types, `shownErrors`, `OpenuiProgramsV1`
and `createErrorReporter` ([`src/client/folds.ts`](src/client/folds.ts),
[`src/client/surface/program-data.ts`](src/client/surface/program-data.ts)).

## The skill

The host registers the skill `papercraft` at activation with `order` 3410 and
`alwaysAvailable: false`, `allowedTools: ['comment_reply']`, the description
"Previews repository components and exports live in the conversation: OpenUI
Lang programs in papercraft fences, with the repository library, Export and
pinned comments. Load it before writing a papercraft fence.", and the body of
[`src/host/skills/papercraft.md`](src/host/skills/papercraft.md): the fence and
its identity, the patch rule, `Export`, data and local state, repository
libraries, how to write schema files, and how to answer comments. It tells the
agent to load `openui` first. A registration that throws leaves the skill out
([`src/host/index.ts`](src/host/index.ts)). The body is at most 8,000
characters ([`tests/skill.test.ts`](tests/skill.test.ts)).

## The fence node

Chat creates `<papercraft-fence>` for each `papercraft` fence and sets its
`view` (`ChatFenceView`: the fence and every fence of the tag in the Thread)
([`src/client/fence.tsx`](src/client/fence.tsx)).

- The element holds the window's fold of the Thread's `papercraft` fences
  (`programFolds`, built on lang-core's `mergeStatements`) and finds its own
  fence's revision there. A fence's info string names the program's identity;
  a later fence with the same identity is a patch merged by statement name
  ([`src/client/folds.ts`](src/client/folds.ts),
  [`src/client/openui-adapter.ts`](src/client/openui-adapter.ts)).
- A fence with no revision yet shows its text, with "Writing…" while it
  streams or "Incomplete: the answer ended before the fence closed" when it
  was cut.
- A revision draws `PreviewContainer` with `chrome: 'node'`: a square node with
  its own header ([`src/client/surface/preview-container.tsx`](src/client/surface/preview-container.tsx)).
  Only a focused node shows its controls and its armed tool; an unfocused
  node's first press only focuses it, and the wheel pans only the focused node
  ([`src/client/surface/frame-focus.ts`](src/client/surface/frame-focus.ts)).

### Node header and keys

- The header shows the title and `rev <n>`. Its buttons, shown in the node
  only while it is focused: `Abrir` (the node only), which runs
  `papercraft.open-canvas/v2` and is disabled without a Thread in scope;
  `Comentar` (`C`), disabled while no composer is active, which toggles
  comment mode and carries the count of pending and drafted comments; and,
  once any thread it shows is resolved, `Mostrar resolvidos` / `Esconder resolvidos`. In the canvas
  window, `Enviar ao agente (<n>)` shows while there are drafts
  ([`src/client/surface/preview-header.tsx`](src/client/surface/preview-header.tsx),
  [`src/client/surface/controller.ts`](src/client/surface/controller.ts)).
- Keys on the canvas: holding space pans; `Esc` closes the open input, else
  disarms the comment tool, else, in the node, gives the focus back; `C`
  without a modifier toggles comment mode. `Cmd/Ctrl+Enter` is chat's send in
  the conversation and `papercraft.send/v1` in the canvas window
  ([`src/client/surface/gestures.ts`](src/client/surface/gestures.ts)).
- A pin's thread opens in a popover with a reply field (`Responder…`, or
  `Editar comentário…` while editing a draft) and a close button (`Fechar`).
  Each message's menu has `Copiar texto` and, for a draft, `Editar` and
  `Remover da pilha`; the thread's menu has `Copiar âncora` and, for a draft
  root, `Remover da pilha`, else the resolved-threads toggle. A thread has a
  `Resolver` button, `Reabrir` once resolved; a drafted message reads
  `na pilha` in place of its time; the menus are labelled `Mais ações` and
  `Mais ações do comentário`
  ([`src/client/surface/thread-popover.tsx`](src/client/surface/thread-popover.tsx)).
  A new comment's field reads `Adicionar comentário`
  ([`src/client/surface/pins-layer.tsx`](src/client/surface/pins-layer.tsx)).
- A comment without an author reads as `você`, with an identicon; the
  agent's comments wear a bot mark
  ([`src/client/surface/avatar.tsx`](src/client/surface/avatar.tsx)).

### What a canvas reads

For the revision on screen, the canvas reads, with the scope
`{ projectId, threadId }` on every call
([`src/client/surface/program-data.ts`](src/client/surface/program-data.ts)):

1. The library bound at the revision's turn: `papercraft.programs/v1.library`
   with the fence's `turnSequence`; when `ready`, `read` of its module, a
   `not_found` asking `library` again once, then `papercraft.cache/v1.ensure`
   of the entries, once per module `dir` in the window (a failure is
   forgotten, so the next read tries again). A second `not_found` fails the
   library with "The module could not be read from the host"; an `ensure`
   that lists `<dir>/index.js` under `failed` fails it with "the cache refused
   the module: <message>".
2. Each `Export` call whose `path` (and `name`, when given) is a string literal,
   by key `<path>#<name>` (`<path>#` without a name): `papercraft.programs/v1.export`,
   then `read` and `ensure` the same way. At most 8 distinct keys are built; a
   ninth and later key is an error ([`src/client/program-errors.ts`](src/client/program-errors.ts)).
3. The program comments: `comments/v1.list({ kind: 'papercraft-program' })`
   filtered to the identity, replaced by the `comments.*` events of one shared
   `runtime.threads/v1.watchThread` per Thread when the window has it
   ([`src/client/surface/thread-log.ts`](src/client/surface/thread-log.ts),
   [`src/client/domain/preview-state.ts`](src/client/domain/preview-state.ts));
   and the drafts in the Thread's composer stack.

Module URLs are `doric://app/papercraft-modules/<dir>/index.js` and, when the
module has a sheet, `…/index.css`.

### The program frame

Every revision renders in an `<iframe sandbox="allow-scripts">` (an opaque
origin) at `doric://app/frame/index.html?entry=<url of client/frames/openui.js>`,
the URL resolved against the client module's own URL
([`src/client/frame-url.ts`](src/client/frame-url.ts),
[`src/client/surface/live-frame.tsx`](src/client/surface/live-frame.tsx)).

The protocol is number 2
([`src/client/frame-protocol.ts`](src/client/frame-protocol.ts),
[`src/client/frame-constants.ts`](src/client/frame-constants.ts)):

- Handshake: the frame posts `{ papercraft: 2, kind: 'hello' }` to its parent;
  the app, taking it only from that iframe's `contentWindow`, answers
  `{ papercraft: 2, kind: 'connect' }` with a `MessageChannel` port; the frame
  then speaks only on that port, first `{ kind: 'ready', protocol: 2 }`. A
  message with another protocol number is dropped.
- App → frame: `init { theme: 'light' | 'dark'; capture: 'none' | 'first' | 'all'; library?: { module; styles? } }`;
  `program { text; streaming; exports: Record<key, { module; styles? }> }`,
  repeatable and never resetting the program's local state; `theme`,
  `capture`, `hidden { ids }`, `cursor { locked; cursor? }`, `measure` and
  `dispose`.
- Frame → app, each parsed with a strict schema and dropped when it does not
  parse or arrives before `ready`: `mounted { mode: 'module' | 'markup' | 'fallback'; layout: 'centered' | 'padded' | 'fullscreen' }`,
  `size { width; height }`,
  `pointer { type: 'move' | 'down' | 'up' | 'click' | 'leave'; point; button; buttons; nodeId?; pseudo?; altKey; ctrlKey; metaKey; shiftKey }`,
  `wheel { point; deltaX; deltaY; deltaMode; altKey; ctrlKey; metaKey; shiftKey }`,
  `key { type: 'keydown' | 'keyup'; key ≤ 32; code ≤ 32; repeat; altKey; ctrlKey; metaKey; shiftKey }`,
  `focus { focused }`, `error { message ≤ 4,096; stack? ≤ 16,384 }`,
  `scene { nodes ≤ 400 }` (ids `n0`…, tag, classes, element id, text ≤ 120,
  clipped bounds, `::before`/`::after` boxes, and the nearest statement's
  `statement` and `component` names) and `errors { errors ≤ 50 of { code; statementId?; message ≤ 1,024 } }`,
  sent again with `[]` once resolved. There is no action message.
- Capture `all` swallows the preview's pointer and key events and reports them
  for the canvas tools; `first` does so until the first `pointerdown`; `none`
  lets the preview handle them and still reports pointer and wheel
  ([`src/client/frames/preview/input.ts`](src/client/frames/preview/input.ts)).

The runtime ([`src/client/frames/openui/runtime.ts`](src/client/frames/openui/runtime.ts),
[`src/client/frames/preview/shell.ts`](src/client/frames/preview/shell.ts))
renders the program with OpenUI's `Renderer` and the library `openuiLibrary`
of react-ui, plus `Export`, plus the repository library's components; it wraps
each named statement for the scene and states the theme on `<html>`
(`class="dark"`). Before it imports the library it publishes the OpenUI and
zod namespaces at `globalThis[Symbol.for('doric.papercraft.openui')]`, which a
library's shims read; a library whose `papercraftAbi` differs from
`SHIM_ABI`, or that does not load, is left out with a reported error and the
program draws with the built-ins. A library's `Harness` export wraps the whole
program. `Export(path, name?, props?)` draws a placeholder until its module is
built, then calls the module's `mount(element, { theme, args })`, where `args`
is `props`. The build of `packages/bundle` leaves only the frame's
`frameExternals` external (React, ReactDOM and Base UI,
[`externals.ts`](../../../packages/bundle/src/build/externals.ts)) and bundles
every other import it allows into the frame
([`parts.ts`](../../../packages/bundle/src/build/parts.ts)), so the frame
carries its own copy of react-ui's `zustand` peer: 4.5.7, nested in the
bundle's `node_modules`
([`package-lock.json`](../../../package-lock.json)). The frame's
`localStorage` and `sessionStorage` are in-memory stores installed before any
module loads; nothing persists
([`src/client/frames/preview/storage.ts`](src/client/frames/preview/storage.ts)).
The frame's three sheets are Doric's tokens, react-ui's layered sheet and
Doric's `--openui-*` tokens ([`src/client/frames/openui/sheets.ts`](src/client/frames/openui/sheets.ts)),
set as `<style>` text. The `index.css` of a library or an `Export` module is
linked before the module mounts; one that has not loaded after 3 s is waited
for no longer.

### Live frames and snapshots

- A window keeps at most 3 live frames: the previews used most recently
  (published or first mounted, pointed at or pressed, or live and on screen).
  The others draw a stand-in: their snapshot, else a placeholder with their
  size and title, over the last scene their frame reported
  ([`src/client/surface/live-frames.ts`](src/client/surface/live-frames.ts),
  [`src/client/surface/stand-in.tsx`](src/client/surface/stand-in.tsx),
  [`src/client/surface/frame-memory.ts`](src/client/surface/frame-memory.ts)).
  The canvas window's revision is always live and outside that count.
- When the chat views are available, the client boots one warm program frame
  per window, handshaken up to `ready` and hidden off screen; it holds one of
  the live frames until a fence takes it or previews used more recently take
  its place ([`src/client/index.ts`](src/client/index.ts),
  [`src/client/surface/live-frames.ts`](src/client/surface/live-frames.ts)).
- A live frame stable on screen for 300 ms (mounted, unmoved, wholly inside
  the viewport, nothing over it, no hidden layer, no gesture) is captured
  through `papercraft.snapshot/v1` with the canvas's own drawings concealed.
  Snapshots are kept in memory, keyed by canvas, revision, theme and width, at
  most 24, least recently drawn forgotten first; a failed capture is silent
  ([`src/client/surface/snapshots.ts`](src/client/surface/snapshots.ts)).
- A frame that has not said `mounted` within 10 s shows its stand-in and is
  reported as `fallback` ([`src/client/surface/preview-surface.tsx`](src/client/surface/preview-surface.tsx)).

### Errors

- The app's own check of the program text adds, per statement:
  `unknown-function` for `@ToAssistant`, `@OpenUrl` or `@Run`;
  `tool-not-found` for a `Query` or `Mutation` statement ("Query and Mutation
  are not available; write the data as literals."); `unknown-component` for
  `AskForm` ("Questions go in openui-lang fences."); `runtime-error` for an
  `Export` key past the eighth; `render-error` with the build error of a
  failed `Export` ([`src/client/program-errors.ts`](src/client/program-errors.ts),
  [`src/client/surface/program-data.ts`](src/client/surface/program-data.ts)).
- Only the fence node reports, never the canvas window, and nothing is reported
  while the library answers `failed`. One reporter per fence revision sends
  `openui.programs/v1.reportErrors` with tag `papercraft`, the fence key,
  identity and revision; the frame's errors go with their code and statement
  only, and errors naming a statement the program lacks are dropped. How a
  report reaches the agent is `openui`'s ([README](../openui/README.md)).
- The card under the canvas lists the library's failure, then, once the fence
  is complete, the revision's errors. A complete revision with errors that
  draws nothing (`no-root`, `parse-failed`, or an empty scene) shows "Nothing
  to draw: this program has errors."
  ([`src/client/surface/preview-container.tsx`](src/client/surface/preview-container.tsx)).

### Comments

- With the comment tool armed, a click on an element wrapped by a statement
  anchors with `{ form: 'selector', selector: <statement>, label: <component, else tag>, x, y }`;
  a click on no statement, or with `Alt` held, anchors with
  `{ form: 'point', x, y }` ([`src/client/anchor.ts`](src/client/anchor.ts),
  [`src/client/surface/gestures.ts`](src/client/surface/gestures.ts)).
- A confirmed note adds an item to the Thread's `chat.composer/v1` stack:
  `{ kind: 'papercraft-program', elementTag: 'chat-comment-line', data: PreviewItemData, note }`,
  with the target `{ kind: 'papercraft-program', id: <identity>, revision, anchor }`
  and `refs: { title: <identity> }`. A reply in a pin's thread is an item with
  `inReplyTo`. Notes are edited and removed through `updateNote` and
  `removeItem`. Without an active composer the gesture is unavailable
  ([`src/client/comment.ts`](src/client/comment.ts)).
- When chat sends a prompt it dispatches `doric:prompt-send`; an open note is
  confirmed first and joins the stack. In the canvas window,
  `papercraft.send/v1` confirms the open note and calls `chat.send/v1.send`
  ([`src/client/surface/comment-flow.ts`](src/client/surface/comment-flow.ts)).
- The send runs the desktop flush of the `papercraft-program` kind: an item
  with a non-blank note and a program target answers one
  `comments/v1.add { target, text: <trimmed note>, commentId: <item id>, inReplyTo?, author? }`;
  any other item answers none and stays drafted
  ([`src/desktop/comment-flush.ts`](src/desktop/comment-flush.ts)).
- Pins show the threads of every revision: a root and its replies, `done` once
  resolved, `await` while the agent spoke last, `open` otherwise, and drafts.
  A thread keeps its number across revisions and re-places its pin through its
  anchor ([`src/client/surface/threads-view.ts`](src/client/surface/threads-view.ts)).
  Resolving calls `comments/v1.resolve` under the prompt the root was written
  in.
- On `doric:comment-thread-open` whose target kind and id match, the canvas
  window opens the thread; a fence node opens it only when the asked revision
  (else the newest) is its own.

## The canvas window

The route `/papercraft/:projectId/:threadId/:identity` is registered without a
parent, so no workspace layout mounts around it. It creates
`<papercraft-canvas>`, which draws `PreviewContainer` with `chrome: 'canvas'`:
full-screen, the element tree on the left, the command bar at the bottom
centre, and nothing without a Thread
([`src/client/elements.tsx`](src/client/elements.tsx)). The window reads the
Thread's fences through `chat.views/v1.watchFences`. Every revision opens
fitted; pan and zoom use the helpers of `desktop/ui/viewport`
([`src/client/surface/fit.ts`](src/client/surface/fit.ts),
[`src/client/surface/viewport.ts`](src/client/surface/viewport.ts)).

## Other events

The client registers a projector that claims `artifacts.created/v1`,
`artifacts.revised/v1`, `artifacts.applied/v1` and `artifacts.approved/v1` and
draws nothing for them ([`src/client/old-artifacts.ts`](src/client/old-artifacts.ts)).
A projector registration that throws leaves the other bundle's projection in
place.

## Repository libraries

A repository library is the set of components declared under
`.doric/papercraft/schemas/` of a library root.

### Binding and the hooks

The host keeps, per Thread, the `papercraft.cwd/v1` events read so far, the
sequence at which the Thread loaded the `papercraft` skill (a `tool.started` of
`load_skill` with name `papercraft`), and the last library instruct; a
`history.truncated` event drops what lies after its `afterSequence`
([`src/host/library.ts`](src/host/library.ts)).

- `onPromptStartedHook`: reads the Thread's new events through
  `runtime.threads/v1.threadEvents` (a failed read ends the hook); appends
  `papercraft.cwd/v1 { cwd }` when `cwd` differs from the last bound one. It
  stops there while the Thread has not loaded the skill. Otherwise it builds
  the library instruct from the last answer recorded for `cwd`
  (`lastAnswerOf`), gives it when its text changed
  (`runtime.threads/v1.instruct` with reason `library`, `retain: true`;
  recorded only when `steered` or `queued`), and then starts a library job
  for `cwd` without awaiting it; that job's answer feeds the next instruct.
- `onThreadCwdChangedHook`: the same, only for an input with a `promptId`, and
  without the job.
- A fence's library is the `cwd` of the last binding whose sequence is below
  the fence's `turnSequence`; `library` reads the Thread's events first when
  `turnSequence` is past what was read.

The instruct texts, at most 16,000 characters: "Repository library at <root>:
N components." then one `<signature> — <description>` line per component, with
"Also: …" naming those that do not fit and, when a Git rule hides the schema
files, a line naming the rule and telling the agent to tell the reader; "The
repository library at <root> did not compile: <error>"; "The repository
library could not be checked: <reason>"; and, after an earlier root, "No
repository library here; use built-in components only."

### The library job

The runner's library job ([`src/sandbox/library.ts`](src/sandbox/library.ts)):

1. Walks up from `cwd` to the first directory whose
   `.doric/papercraft/schemas/` holds an entry file (`.ts`, `.tsx`, `.js` or
   `.jsx` directly in it), stopping after the nearest directory with `.git`, or
   at the workspace root; none answers `none`. A `cwd` that is gone answers
   `failed` ("The working directory <cwd> no longer exists").
2. Answers `unchanged` when the root equals the previous answer's and every
   path of the previous manifest hashes as recorded (the manifest maps each
   path read to its SHA-256, `null` when absent; a path ending in `/` hashes
   its sorted entry names).
3. Runs `git check-ignore -v` on the first entry file, for at most 5 s, and
   reports the rule that hides it as `ignoredBy`; then checks the limits: at
   most 100 entry files, each at most 16 KiB, at most 1 MiB under `schemas/`.
4. Bundles the entry files for Node with every import outside `schemas/`
   replaced by a stub ([`src/sandbox/stubs.ts`](src/sandbox/stubs.ts)) and
   evaluates them in a worker for at most 10 s. Each entry file must export
   exactly one `defineComponent` result, named after the file's base name; a
   schema that reads a stub's value fails naming the import; a name equal to a
   built-in (`BUILTIN_COMPONENT_NAMES`), to `Action`, `Query`, `Mutation` or
   `AskForm`, to a lang-core call, or to another entry's fails. Signatures come
   from lang-core's `createLibrary(...).toSpec()`.
5. Bundles the harness alone for its global CSS (one that does not compile is
   left out with a warning), then the library module for the browser:
   `export const components = [...]`, `export const papercraftAbi = SHIM_ABI`,
   and `Harness` when there is a harness. `@openuidev/react-lang`,
   `@openuidev/lang-core`, `zod`, `zod/v4` and `zod/v4/core` resolve to shims
   over the frame's namespaces; any other zod entry fails ("This zod entry is
   not served in papercraft libraries; import from 'zod'.").

### The host memo and the queue

[`src/host/programs.ts`](src/host/programs.ts):

- The memo holds library entries by `(projectId, 'library', root)` and export
  entries by `(projectId, 'export', '<path>#<name>')`, at most 64 MiB of
  module bytes, least recently used first out.
- A `built` library is finished on the host: `HOST_PACKAGES` bundled in, the
  sheet compiled with the files it read hashed into the manifest.
- Each Project runs at most two jobs at once, library jobs ahead of exports.
  Calls for one `cwd` share a job that has not started; a call during a
  running job waits for the next one.
- With no sandbox lease, `library` answers the previous root's built module
  when the memo holds it, else `failed` with "The Project's sandbox is not
  running; repository components need it". Any other `unavailable` answers
  `failed` ("The sandbox could not run the library job: <reason>") and holds
  that answer for the `cwd` for 5 minutes, except for the lasting reasons: no
  `node` in the sandbox, another esbuild version, esbuild not loadable, a host
  built without the runner.

## Export builds

`export` compiles one component source into `index.js` (exporting
`mount(root, { theme, args })`), `index.css` and its assets
([`src/host/compile.ts`](src/host/compile.ts),
[`src/host/bundle.ts`](src/host/bundle.ts), [`src/host/entry.ts`](src/host/entry.ts)):

- The bundle runs in the sandbox through the runner when it can; when the
  sandbox answers `unavailable`, the host bundles through `files/v1`, within
  1,500 reads (hits and misses) and 8 MiB of source per compile; a compile
  past either answers `failed` ("The preview reads more than 1500 files from
  the sandbox …; stub large dependencies in the preview wrapper." or "The
  preview bundles more than 8388608 bytes of source …; stub large dependencies
  in the preview wrapper."). The
  runner's bundle in the sandbox has no budget
  ([`src/host/bundle.ts`](src/host/bundle.ts),
  [`src/sandbox/run.ts`](src/sandbox/run.ts)). A source that does not bundle
  makes `export` answer `failed` with esbuild's errors in its message.
- The budget limits stories that reach `monaco-editor`, as one that imports
  `desktop/ui/code` does: [`code-view-theme.ts`](../../../packages/desktop/src/code/code-view-theme.ts)
  imports it, and the one-file bundle inlines the dynamic import of
  [`monaco-runtime.ts`](../../../packages/desktop/src/code/monaco-runtime.ts).
  That brings some 720 `monaco-editor` files and 6.7 MiB of source, and each
  `./x.js` import also tries `x.ts` and `x.tsx`, so such a story exceeds the
  1,500 reads and previews only when the sandbox runs the bundle, or with the
  editor stubbed in the preview wrapper.
- The mounted export is `name` when given; else `default`; else the one
  PascalCase export. A CSF file (`*.stories.(tsx|ts|jsx|js|mjs|mts)`) mounts
  the story `name`, else its first story in source order, with
  `args = { ...preview.args, ...meta.args, ...story.args, ...args }`, where
  the last `args` are the ones `mount` receives (the `props` of `Export`);
  parameters merge one level deep, and decorators apply in Storybook's order.
  A plain component renders with `{ ...preview.args, ...args }` as its props.
  `mount` sets `data-papercraft-layout` (`centered` by default, `padded` or
  `fullscreen`) ([`src/host/entry.ts`](src/host/entry.ts)).
- `export` answers `failed` for a file without the export `name` ("The
  component "<path>" has no export "<name>" (exports: …)."), a file with no
  `default` and not exactly one PascalCase export when no `name` is given, a
  stories file without the story `name`, and a stories file that exports no
  story ([`src/host/bundle.ts`](src/host/bundle.ts)).
- Resolution: `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`,
  `react-dom` and `react-dom/client` stay external for the frame's import map,
  as does each `@base-ui/react` specifier the window serves; Node built-ins
  fail; relative imports and `tsconfig.json` `paths` resolve in the Project
  (`./x.js` tries `x.ts` and `x.tsx` first); `lucide-react` is bundled from the
  host; any other package is read from the Project's `node_modules`.
- The harness is the nearest `.storybook/preview.<ext>`, else
  `.papercraft/preview.<ext>` (`.tsx`, `.ts`, `.jsx`, `.js`), walking up from
  the source, skipping `.doric/` and `node_modules/`, stopping after the
  nearest repository root. Its default or named `decorators`, `parameters` and
  `args` apply; `@storybook/addon-themes` is a built-in stand-in; a harness
  that does not compile is left out with a warning
  ([`src/host/harness.ts`](src/host/harness.ts),
  [`src/host/files.ts`](src/host/files.ts)).
- The sheet is Tailwind v4: the harness's global CSS, else a generic neutral
  theme, then the components' CSS. A Tailwind v3 sheet, a JavaScript
  `@plugin` or `@config`, and a component sheet that is itself a Tailwind
  entry are skipped with a warning; relative `url()` assets are stored as
  `assets/<sha256>.<ext>` ([`src/host/css.ts`](src/host/css.ts),
  [`src/host/theme.ts`](src/host/theme.ts)).

## The sandbox runner

[`src/host/sandbox.ts`](src/host/sandbox.ts),
[`src/sandbox/main.ts`](src/sandbox/main.ts),
[`src/sandbox/protocol.ts`](src/sandbox/protocol.ts),
[`src/sandbox/run.ts`](src/sandbox/run.ts):

- Each job runs on the Project's current lease. The host first writes
  `.doric/papercraft/.gitignore` when absent (`/*`, `!/.gitignore`,
  `!/schemas/`) and, once per Project per host session, deletes a
  `.doric/.gitignore` whose whole content is `*`, after writing
  `.doric/artifacts/.gitignore` (`*`) when `.doric/artifacts/` exists without
  one ([`src/host/ignore.ts`](src/host/ignore.ts)).
- The runner is copied to `.doric/papercraft/runner-<hash>.mjs` when absent;
  the input is written to `.doric/papercraft/jobs/<uuid>/input.json`; the host
  runs `node <runner> <input> <output>` from the workspace root with a 120 s
  timeout, reads `output.json` (at most 64 MiB) and removes the job folder.
- The runner loads esbuild from
  `/opt/doric/bundler/node_modules/esbuild/lib/main.js`, which the sandbox
  image installs ([`.sandbox.Dockerfile`](../../../app/backend/doric-host/.sandbox.Dockerfile)),
  and answers `unavailable` when its version differs from the host's.
- Exit code 127, an `unavailable` answer from the runner and the reasons it
  names mark the sandbox unable for the host's life. Another exit code, an
  unreadable output or a thrown error answer `unavailable` with the reason.
- A job input without `kind` is a bundle job; `kind: 'library'` is a library
  job. The output schemas are `runnerOutputSchema` and `libraryOutputSchema`.

## Data and persistence

| Data                       | Where                                                  | Lifetime                                 |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Programs and revisions     | The agent's answers in the Thread log                  | The Thread's                             |
| `papercraft.cwd/v1` events | The Thread log                                         | The Thread's                             |
| Comments                   | `comments/v1` events; drafts in `chat.composer/v1`     | `comments`' and chat's                   |
| Schema files               | `.doric/papercraft/schemas/` in the Project, versioned | The Project's                            |
| Runner, jobs, `.gitignore` | `.doric/papercraft/` in the Project, ignored by Git    | Jobs removed after each run              |
| Host memo, holds, bindings | Host memory                                            | The host process                         |
| Module cache               | `userData/papercraft/<dir>/<file>`                     | Cut back at each app session's first use |
| Snapshots, frame memory    | Window memory (24 snapshots, 64 frame readings)        | The window                               |
| Frame storage              | Frame memory                                           | The frame                                |

No Project file outside `.doric/papercraft/` is written, except
`.doric/artifacts/.gitignore` and the removal of `.doric/.gitignore`, as
[The sandbox runner](#the-sandbox-runner) states.

## Build and test

```console
npx nx run bundle-papercraft:build
npx nx run bundle-papercraft:typecheck
npx nx run bundle-papercraft:test
```

The `test` target builds the bundle, compiles `tests/` and `tests/client/`
into `dist-tests/`, copies the skill beside the compiled host, and runs
`node --test` over both folders ([`project.json`](project.json)). Tests in
`tests/` run without a DOM; tests in `tests/client/` boot `happy-dom`.

`src/sandbox/shim-names.ts` is generated by
[`scripts/shim-names.mjs`](scripts/shim-names.mjs) from the installed
`@openuidev/react-ui`, `@openuidev/react-lang`, `@openuidev/lang-core` and
`zod`: `BUILTIN_COMPONENT_NAMES`, `SHIM_NAMES` and `SHIM_ABI` (the SHA-256 of
`SHIM_NAMES` as JSON). [`tests/shims.test.ts`](tests/shims.test.ts) fails
until the committed file equals what the script writes:

```console
node bundles/features/papercraft/scripts/shim-names.mjs
```
