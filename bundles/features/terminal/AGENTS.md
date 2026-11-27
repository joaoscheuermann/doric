# terminal

Apply these rules to `bundles/features/terminal/`, after the root
[`AGENTS.md`](../../../AGENTS.md) and [`bundles/AGENTS.md`](../../AGENTS.md).

## Function

Keep this bundle to tracked shell commands and manual terminal sessions in a
Thread's Project sandbox: the sessions and their stream (`terminal/v1`), the
`terminal` tool, and the window's drawings of those sessions, of the
`terminal` tool's calls and of the input source `terminal`. Do not add another
tool, a filesystem or Git read, or a drawing of another bundle's tool or input
source: each belongs to the bundle that owns it, which reaches the sandbox
through its own contracts.

## Rules

- Read [`README.md`](README.md) for what the bundle does before adding to it.
- Start, track, redact, stop and remove sessions only in
  [`src/host/registry.ts`](src/host/registry.ts), and keep them in process
  memory: never store a session or its output.
- Run every command of the `terminal` tool through this bundle's own
  `terminal/v1` `run`, in the calling prompt's scope; never start a process
  from [`src/host/tool.ts`](src/host/tool.ts).
- Never call `run` from the window: it runs on the calling prompt's Thread.
  Implement every other method a window calls in
  [`src/host/provider.ts`](src/host/provider.ts); the window reaches it
  through the manifest's `desktopScope`.
- Call `redactions.refresh()` inside the `withThread` task before every
  `registry.start`, and pass the session's command, each marker's command and
  each output chunk through the redaction list; leave the `stdout` and
  `stderr` of a `TerminalResult` as the sandbox returns them, since the
  runtime redacts what the conversation stores.
- Never write a terminal's command or output to the log; log only through
  `log/v1`, with ids, never with text the process produced.
- Never let the `onThreadsClosingHook` handler reject: catch and log its
  failure, since the runtime awaits it where Threads close.
- Keep the stream rules of [`src/host/watch.ts`](src/host/watch.ts): a
  snapshot first on every subscribe, `updated` and `removed` items held until
  it, and output never buffered for a subscriber.
- Never change the input or result of `run`: the baseline shapes of
  [`tests/host-parity.test.ts`](tests/host-parity.test.ts) pin them. Add a new
  method only to `TerminalService` in
  [`src/contracts/index.ts`](src/contracts/index.ts) and to
  `proto/doric/terminal/v1/terminal.proto`, never to `Terminal`.
- Add a method a window calls in four places in the same change: the
  interface and its schema in `src/contracts/index.ts`, its provider in
  `src/host/provider.ts` backed by the registry, its wrapper with argument
  checks and error messages in [`src/client/api.ts`](src/client/api.ts), and
  the `TerminalHost` pick of that file.
- Reach `runtime.workspace/v1`, `runtime.threads/v1` and `runtime.hooks/v1`
  from the host part only through the structural copies in
  [`src/host/peers.ts`](src/host/peers.ts), narrowed to what the bundle calls,
  and change a copy in the same change as the runtime changes that shape:
  nothing checks the copy against the runtime's definition.
- Import other bundles' contracts in the client part only through
  [`src/client/peers.ts`](src/client/peers.ts). Import `chat/contracts` with
  `import type` only and build `ChatViewsV1` from its id, so that a window
  without `chat` loads this bundle. Never import `files/contracts`; keep
  `FilesRefresh` a structural copy. The rule kept the import from closing a
  cycle while `files` depended on `terminal`; the tests that imported
  `terminal/contracts` went in slice S68b and the dependency in S70.
- Keep `chat.views/v1` and `files.refresh/v1` under `optional` in
  [`manifest.json`](manifest.json); register each chat drawing in its own
  `services.whenAvailable`, and wrap every other use of an optional contract
  so that its absence draws nothing and refreshes nothing.
- Keep the window's terminal state in the one store
  [`src/client/store.ts`](src/client/store.ts) that `activate` creates, and
  have elements read it; never keep a session list in an element.
- Read a terminal's output only through `watches.watch` of
  [`src/client/output-watch.ts`](src/client/output-watch.ts), which shares one
  watch per terminal; never open a second stream for a terminal.
- Make every `terminal/v1` call of the window through
  [`src/client/api.ts`](src/client/api.ts), never through the service
  directly, so that its checks, its write order and its messages apply.
- Register the header button and the sidebar rows only inside
  `registerTerminalSurfaces` in [`src/client/index.ts`](src/client/index.ts),
  and keep `busy` answering from memory: the sidebar calls it for every
  Thread on every render.
- Build and read a terminal tab's id only with `terminalTabId` and
  `terminalIdOfTab` of [`src/client/tab.ts`](src/client/tab.ts).
- Load xterm only through `loadXterm` of
  [`src/client/view/xterm.ts`](src/client/view/xterm.ts).
- Keep the `@source` lines of [`src/client/styles.css`](src/client/styles.css)
  for the window bundles' client sources, so that this sheet never emits a
  shared class after those bundles' responsive variants.
- Add a feature to this bundle in these places:
  - a change to how sessions start, run, end or are redacted in
    `src/host/registry.ts`, with its test in
    [`tests/registry.test.ts`](tests/registry.test.ts);
  - a change to a method or to background delivery in `src/host/provider.ts`,
    with its test in [`tests/router.test.ts`](tests/router.test.ts);
  - a change to the stream in `src/host/watch.ts`, tested in
    `tests/router.test.ts`;
  - a change to the `terminal` tool's input, output or compaction in
    `src/host/tool.ts`, with its test in
    [`tests/tool.test.ts`](tests/tool.test.ts);
  - a window behavior in `src/client/`: the model and labels in
    `src/client/domain/`, the store in `src/client/store.ts`, the streams in
    `src/client/output-watch.ts`, the sidebar rows in `src/client/rows/`, the
    tab in `src/client/tab.ts`, the emulator in `src/client/view/`, and the
    chat drawings in `src/client/chat/`;
  - a new element defined through `ui/v1` in `src/client/index.ts`, built in
    `src/client/elements.tsx` or `src/client/chat/`.
- Extend the window only through the extension points the bundle already
  uses: the region `shell.header.actions`, `workspace.sidebar/v1` Thread rows,
  `layout.tabs/v2` tabs and the `chat.views/v1` renderers of the tool
  `terminal` and the source `terminal`.
- Add each `src/client/` file that a test under `tests/` (outside
  `tests/client/`) imports to the `include` of
  [`tsconfig.spec.json`](tsconfig.spec.json): that target compiles only the
  client files listed there. Put shared helpers of `tests/client/` in
  `tests/client/support/` and those of `tests/` in `tests/support/`.
- Run [`tests/docker.test.ts`](tests/docker.test.ts) after a change to how
  the registry starts a process or reads its markers: it runs only with
  `DORIC_TEST_SANDBOX=true` and a local Docker.
- Add or update the story of each element you add or change, under
  [`stories/`](stories), with its fixtures in `stories/support/`.
- Change [`tests/manifest.test.ts`](tests/manifest.test.ts) and
  [`tests/workspace-sheet.test.ts`](tests/workspace-sheet.test.ts) in the same
  change as the manifest's `version`, `provides`, `requires` or `optional`:
  they assert them.
- Update the feature doc [Terminal](../../../docs/features/terminal.md) with
  any change to sessions, the `terminal` tool, background results or the
  window's terminal surfaces, and each other feature doc the README lists when
  the change touches its flow.
- Before adding an exception for this bundle, open
  [`tests/boundary-exceptions.json`](../../../tests/boundary-exceptions.json)
  and search it for `"bundle": "terminal"`.

## Verify

- `npx nx run bundle-terminal:typecheck`: run it after any change under
  `src/`, `stories/` or `.storybook/`.
- `npx nx run bundle-terminal:test`: run it after any change under `src/` or
  `tests/`, and run the tests only through this target, which builds the
  bundle first; set `DORIC_TEST_SANDBOX=true` to include the Docker test.
- `npx nx run bundle-terminal:build`: run it after a change to
  `manifest.json`, `package.json`, a `tsconfig*.json` file, `src/contracts/`
  or `src/client/styles.css`.

## Generated files

None beyond those [`bundles/AGENTS.md`](../../AGENTS.md) lists.
