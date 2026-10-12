# Layout Bundle Agent Instructions

These instructions apply to `bundles/desktop/layout` and narrow the root `AGENTS.md`.
The layout is the workspace frame of the desktop window: Projects and Threads,
the header, the side panel, the tabs and the footers. It moved here from
`app/desktop/doric-renderer` in stage 9 and must keep that renderer's visible text,
roles, layout and quirks.

## Layers

`src/client/` keeps the renderer's layering:

```
src/client/
  components/{molecules,organisms,templates}/
  views/       pages: own the state, compose templates
  elements/    the custom elements `ui/v1` defines
  hooks/       every `use*` hook
  stores/      Zustand stores
  queries/     TanStack Query keys, the client, the refresh queue
  domain/      the vocabulary of the product (pure, tested)
  utility/     helpers stated only in terms of their arguments
  api/         the host adapters: the only code that calls host contracts
  services/    the layout's own contract providers and activation services
  provisional/ stage-10 features kept in the layout's geometry
```

- A rule that can be stated in terms of its arguments belongs in `domain/` or
  `utility/` and has a test; code that needs React or the DOM is proven in the
  running app.
- The shadcn primitives are `desktop/ui/<name>`; `toast` comes only from
  `desktop/ui/sonner`, so a window has one toast store.
- Imports are relative with `.js` extensions; the package is ESM and the part
  is bundled by `bundle`'s build.

## Boundaries

- The client part never imports `bundle`, `bundle/runtime` or
  `desktop/client`, and touches no DOM at module load.
- `runtime/contracts` is imported for types only; contract references are
  built from their IDs in `api/host.ts`.
- Persistent work (watches, the selection route, timers) is bound to the
  activation services, never to an element's services (D9-17).
- `src/client/styles.css` holds only the Monaco and xterm slider rules; the
  utilities this bundle uses are emitted by the shell's sorted sheet, so do not
  add Tailwind directives here (WP6 decision on the cascade).
- Every host failure shows the message the REST path showed (R-ERR); the
  adapter in `api/workspace-api.ts` owns those messages.

## Footers

All footer text, including nested controls, uses `font-weight: 400`. Use a
semantic `footer` element or a `data-slot` ending in `-footer` so the shell's
footer rule (`app/desktop/doric-renderer/src/styles.css`) applies.

## Tests

`tests/*.test.ts` are DOM-free and run under `node --test` from
`dist-tests`, which the test target removes first. Validate with:

```
npx nx run bundle-layout:typecheck
npx nx run bundle-layout:test
npx nx run bundle-layout:build
```
