# Renderer Agent Instructions

These instructions apply to `app/doric-renderer` and narrow the root
`AGENTS.md`. Read that one first; this file only adds what is specific to the
renderer.

## Layers

```
src/
  components/
    ui/          atoms: the vendored shadcn primitives
    molecules/   a few atoms composed into one small unit
    organisms/   one functional section of the app, with its own data
    templates/   arrangement only: layout and regions, no app state
  views/         pages: own the state, read the hooks, compose templates
  hooks/         every `use*` hook
  domain/        the vocabulary of the product
  utility/       small helpers with no product vocabulary
```

Where a new file goes, in order:

1. Does it render? Then it is a component, and its level decides the folder.
   - One element with no composition and no behaviour: it belongs in
     `components/ui`, which is the atom layer.
   - A few atoms composed into one thing a person uses as a unit: `molecules`.
   - A section that fetches or subscribes to something: `organisms`.
   - Nothing but arrangement — a layout, a region, a slot taking `ReactNode`:
     `templates`.
2. Does it own a page's state and compose templates? Then it is a `view`.
3. Does it start with `use`? Then it is a `hook`, whatever it talks to.
4. Does it name what the product is about — a Thread, a Project, a tab, the
   projection of the event log? Then it is `domain`.
5. Otherwise it is `utility`: a helper stated in terms of nothing but its
   arguments, such as `cn`.

Two boundaries inside `components` matter and are easy to break:

- `components/ui` is **vendored**. The shadcn CLI writes those files and
  `components.json` points at them, so do not move, rename or reorganise that
  folder; keep new primitives coming through the CLI. Its aliases (`utils`,
  `lib`, `hooks`, `ui`) are part of that contract and must keep resolving to
  paths that exist.
- A `template` must not know a `view`, and a `molecule` must not know an
  `organism`. Data enters from above, through props or a hook.

## Imports

- Anything crossing a folder is imported through the `@/` alias
  (`@/domain/workspace`, `@/components/molecules/inline-name`).
- Only imports inside one folder stay relative (`./use-thread-chat`).
- `cn` lives in `@/utility/utils`, which is also what `components.json` points
  the shadcn CLI at.

## The IPC boundary

The renderer never opens HTTP or Socket.IO. Everything it knows about the host
arrives through `window.doric`, typed in `src/doric.d.ts` and implemented by the
preload in `app/doric`. The main process owns the connection, the single
selected-Thread subscription and the selected-Project tree; the renderer asks
for those and subscribes to what comes back. Adding a transport to the renderer
is a boundary change, not a feature.

Conversation history is durable in PostgreSQL and replayed, never invented
locally: a surface subscribes, accumulates what arrives, and treats its own copy
as a view. `useThreadChat` is the one place that does this for a Thread.

## Styling

Tailwind and the shadcn surface belong here, not in `app/doric`. Prose and
machine-facing surfaces use the fonts vendored under `src/assets/fonts`, because
the packaged CSP allows fonts from `self` only. Rules that Tailwind's optimizer
mis-parses, such as a Custom Highlight pseudo-element, belong in the shell
(`src/index.html`).

## Tests

The test target compiles a fixed root list from `tsconfig.spec.json` and runs it
under `node --test`, so tests here are pure and DOM-free: `domain/` and
`utility/` code is testable, components are not. A component's behaviour has to
be proven elsewhere — in the running app.

Two traps:

- The test target does not clean `dist-tests`, so a test file you deleted keeps
  running from its stale build output. Remove `app/doric-renderer/dist-tests`
  after deleting one.
- The dev server's type checker keeps a program cache across edits: after adding
  a file it can report `TS6307 "not listed within the file list"` even though
  `tsc` is clean and the `include` pattern is right. Restart the dev server.

## Validate

Run these from the repository root and report what they printed:

```
npx tsc -p app/doric-renderer/tsconfig.app.json --noEmit
npx tsc -p app/doric-renderer/tsconfig.spec.json
npx eslint app/doric-renderer
npx prettier --check app/doric-renderer
NX_SOCKET_DIR=/tmp/nx-tmp npx nx test doric-renderer
NX_SOCKET_DIR=/tmp/nx-tmp npx nx build doric-renderer
```

`nx` needs `NX_SOCKET_DIR` when the checkout path is long, which it is inside a
Delta worktree.
