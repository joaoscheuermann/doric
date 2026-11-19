# Settings Bundle Agent Instructions

These instructions apply to `bundles/desktop/settings` and narrow the root
`AGENTS.md`. The settings bundle is the application-global settings page
(`/settings` and its sections), `settings.models/v1` (what the chat's footer
execution picker offers), and the Dashboard's entries (the Providers group, the provider page
and "All settings"). It moved here from `app/desktop/doric-renderer` in stage 9 and must keep that
renderer's visible text, roles, layout and quirks, including the dropped Tools
edits and the autosave without a Save button.

## Layers

`src/client/` keeps the renderer's layering:

```
src/client/
  components/{molecules,organisms,templates}/
  views/       pages: own the state, compose templates
  elements.ts  the custom elements `ui/v1` defines
  hooks/       every `use*` hook
  queries/     TanStack Query keys and the client
  domain/      the configuration rules and the settings search (pure, tested)
  api/         the host adapter: the only code that calls host contracts
  services/    the providers of `settings.config/v1` and `settings.models/v1`
```

`src/contracts/` is the contracts module `settings/contracts` (built by
`tsconfig.json` to `dist/contracts/`): contract declarations, types and slot
names only — `SETTINGS_SECTIONS`, and `SETTINGS_PROVIDER_FIELD` with
`ProviderFieldItemProps` and `ProviderFieldView`. No file of it imports
`src/client`; the client reaches it by the relative path
`../contracts/index.js`.

- A rule that can be stated in terms of its arguments belongs in `domain/` and
  has a test; code that needs React or the DOM is proven by the window tests in
  `tests/client/` or in the running app.
- `domain/config.ts` mirrors the host's validation so a draft the host would
  refuse is never sent; the host re-validates.
- The shadcn primitives are `desktop/ui/<name>`; `toast` comes only from
  `desktop/ui/sonner`.
- Imports are relative with `.js` extensions; the package is ESM and the part
  is bundled by `bundle`'s build.

## Boundaries

- The client part never imports `bundle`, `bundle/runtime` or
  `desktop/client`, and touches no DOM at module load.
- A secret is never read back: the host answers only whether one is stored.
- Autosave is bound to the activation services and flushes in the window's
  `onFlushHook`, never through an element's services (D9-17).
- The `workspace.dashboard/v1` reference it lists under `optional` is built from
  its id in `src/client/api/navigation-refs.ts`; `workspace/contracts` is
  imported with `import type` only.
- `settings.models/v1` holds every rule the footer picker shows: the chat
  draws the view and writes the Thread, and computes nothing of it.
- The provider page names no provider kind. A kind's link is its descriptor's
  `site`, kept by the adapter only when it is `https:`. A field that a kind
  draws its own way is an item of `settings.provider.field`, drawn in the
  field's place
  (`domain/provider-fields.ts`, `components/molecules/provider-field-element.tsx`);
  `settings` imports no other bundle's contracts for it. The slot's items are
  read through the activation services' `regions/v1` and its elements created
  through their `ui/v1`, not an element's: with the element's services the
  item was never drawn
  ([spec P12](../../../docs/designs/bundle-isolation.md#revisions)).

## Footers

All footer text, including nested controls, uses `font-weight: 400` through the
shell's footer rule: use a semantic `footer` or a `data-slot` ending in
`-footer`, and add no per-control weights inside footers.

Labels and titles are 400 and running text 300, through desktop/ui's components
and the theme's root weight; add no per-control weight to reach them.

## Tests

`tests/*.test.ts` are DOM-free; `tests/client/*.test.ts` boot happy-dom with
the built core and settings parts. Both run under `node --test` from
`dist-tests`, which the test target removes first. Validate with:

```
npx nx run bundle-settings:typecheck
npx nx run bundle-settings:test
npx nx run bundle-settings:build
```
