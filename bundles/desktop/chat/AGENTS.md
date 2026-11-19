# Chat Bundle Agent Instructions

These instructions apply to `bundles/desktop/chat` and narrow the root `AGENTS.md`.
The chat is the conversation of one Thread: its transcript, the composer and
its queue, the trail and the footer composer controls, since 1.8.4 the
Thread tabs and the views of the Threads on screen, and, since 1.9.0, the
footer execution picker, drawn over `settings.models/v1` (no rule of its own:
the groups, the efforts and the execution of each choice are `settings`'). It moved here from
`app/desktop/doric-renderer` in stage 9 and must keep that renderer's visible text,
roles, layout and quirks.

## Layers

`src/client/` keeps the renderer's layering:

```
src/client/
  components/{molecules,organisms}/
  views/       `<chat-view>` and `<chat-composer>`: own the state, compose
  elements/    the custom elements `ui/v1` defines
  hooks/       every `use*` hook
  stores/      Zustand stores: the Thread chat store, the composer, the queue edit
  queries/     TanStack Query keys and the client
  domain/      the vocabulary of the product: projector, turns, queue (pure, tested)
  utility/     helpers stated only in terms of their arguments
  api/         the host and sibling adapters: the only code that calls contracts
  services/    the chat's own contract providers and activation services
```

- A rule that can be stated in terms of its arguments belongs in `domain/` or
  `utility/` and has a test; code that needs React or the DOM is proven by the
  window tests in `tests/client/` or in the running app.
- One file, one responsibility; split along that rule rather than by taste, and
  do not change a neighbour's contract in the same step as the cut.
- The shadcn primitives are `desktop/ui/<name>`; `toast` comes only from
  `desktop/ui/sonner`, so a window has one toast store.
- Imports are relative with `.js` extensions; the package is ESM and the part
  is bundled by `bundle`'s build.

## Boundaries

- The client part never imports `bundle`, `bundle/runtime` or
  `desktop/client`, and touches no DOM at module load.
- Conversation history is durable on the host and replayed, never invented
  locally: the Thread chat store subscribes each opened Thread and treats its
  copy as a view; `history.snapshots/v1` only seeds it.
- Thread watches, history writes and notifications are bound to the activation
  services, never to an element's services (D9-17).
- `chat.lexical/v1` freezes when the first editor is created; nodes and
  extensions registered later are refused.
- `workspace.hooks/v1` is observed through a structural copy
  (`src/client/api/workspace-hooks.ts`); nothing imports `workspace/contracts`
  and `package.json` lists no `workspace` (OD40 O2).
- `workspace.selection/v1` is read through the copy
  `src/client/api/workspace-selection.ts` by the picker and the conversation.
- The collapsible block and its generic open/closed rule are
  `desktop/ui/collapsible-block` (platform 1.10.0); never copy them back here.
  `src/client/domain/collapsible.ts` keeps only the rules that name the chat's
  own blocks.
- Which drawing a tool call or an input gets (`chat.views/v1` 1.2.0) is decided
  only in `src/client/domain/tool-drawing.ts` and
  `src/client/domain/drawn-turns.ts`. The built-in names there (`edit`,
  `write`, `view-image`, `thread-spawn`, `load_skill`) leave in bundle
  isolation 5(b), as their bundles register.

## Styling

`src/client/styles.css` holds the conversation's own rules (the Lexical
placeholder, the conversation scroll and trail, the queue-edit surface and the
`editor-*` markdown theme) with the layering they had in the renderer, and the
unlayered rules a floating footer needs: the conversation's vertical bar and
scroll padding, read from `--shell-conversation-footer-height`, and the viewer footer's height,
fill and blur (conversation-footer spec, §3, §4). `.conversation-scroll` sets
`isolation: isolate`, so the transcript's z-indexed layers (papercraft's pins
and inputs) paint inside the scroll root and a floating footer, later in tree
order, paints over them with no `z-index` (spec §6, D7); keep it, and add no
`z-index` to a footer band. The
utilities this bundle uses are also emitted by the shell's sorted sheet; do not
add a second theme. All footer text, including nested controls, uses
`font-weight: 400` through the shell's footer rule: use a semantic `footer` or a
`data-slot` ending in `-footer`, and add no per-control weights inside footers.
Labels and titles are 400 and running text 300, through desktop/ui's components
and the theme's root weight; add no per-control weight to reach them.

## Tests

`tests/*.test.ts` are DOM-free; `tests/client/*.test.ts` boot happy-dom with
the built core and chat parts. Both run under `node --test` from `dist-tests`,
which the test target removes first. Validate with:

```
npx nx run bundle-chat:typecheck
npx nx run bundle-chat:test
npx nx run bundle-chat:build
```
