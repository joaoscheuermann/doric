# Chat Bundle Agent Instructions

These instructions apply to `bundles/desktop/chat` and narrow the root `AGENTS.md`.
The chat is the conversation of one Thread: its transcript, the composer and
its queue, the trail and the footer composer controls. It moved here from
`app/doric-renderer` in stage 9 and must keep that renderer's visible text,
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

## Styling

`src/client/styles.css` holds the conversation's own rules (the Lexical
placeholder, the conversation scroll and trail, the queue-edit surface and the
`editor-*` markdown theme) with the layering they had in the renderer. The
utilities this bundle uses are also emitted by the shell's sorted sheet; do not
add a second theme. All footer text, including nested controls, uses
`font-weight: 400` through the shell's footer rule: use a semantic `footer` or a
`data-slot` ending in `-footer`, and add no per-control weights inside footers.

## Tests

`tests/*.test.ts` are DOM-free; `tests/client/*.test.ts` boot happy-dom with
the built core and chat parts. Both run under `node --test` from `dist-tests`,
which the test target removes first. Validate with:

```
npx nx run bundle-chat:typecheck
npx nx run bundle-chat:test
npx nx run bundle-chat:build
```
