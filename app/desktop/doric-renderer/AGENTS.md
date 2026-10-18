# Renderer Shell Agent Instructions

These instructions apply to `app/desktop/doric-renderer` and narrow the root
`AGENTS.md`. Read that one first; this file only adds what is specific to the
shell.

## What lives here

Since the stage-9 cut-over this project is only the window shell: the page
every window loads from `doric://app`, served by main under
`/platform/shell@<version>/`.

```
src/
  bootstrap.ts   calls desktop/client's `bootstrapWindow({})`; the core's
                 outlet then shows whatever the active route renders
  shell.html     the template main renders per request (import map, CSP)
  styles.css     the window-wide rules and the sorted utility set
  favicon.ico
```

The UI itself lives in client bundles: the workspace frame in
`bundles/desktop/layout`, the conversation in `bundles/desktop/chat`, the settings page in
`bundles/desktop/settings`, the outlet, regions and router in `bundles/foundation/core`. Each has
its own `AGENTS.md`. Do not add components, hooks, stores or product logic to
the shell; a page or a region item is a bundle's.

## The IPC boundary

The shell never opens HTTP or Socket.IO and has no semantic API. The preload
exposes only `window.doric.desktop` (desktop/client's protocol); every host or
desktop call is a contract call routed by main's dispatcher. Adding a channel
to the preload is a boundary change, not a feature.

## Styling

The window loads desktop/ui's `theme.css` (preflight, faces, tokens, theme
mapping) first, this project's `src/styles.css` next, and each UI bundle's
`client/styles.css` after it. `src/styles.css` holds only window-wide rules —
the base layer, `.chrome-bar` and the footer weight invariant — plus the whole
sorted utility set of the in-repo UI bundles, so that a class two sheets emit
keeps the order one compiled stylesheet gave it. A rule a single bundle draws
belongs in that bundle's sheet.

All footer text, including nested controls, must use `font-weight: 400`, never
500, through the shared rule in `src/styles.css`. Do not override or weaken it.

## Tests

`tests/stylesheet.test.ts` compiles the theme, the shell sheet and the bundle
sheets and checks the cascade they form. The test target removes
`dist-tests` first, so a deleted test never keeps running from stale output.

## Validate

Run these from the repository root and report what they printed:

```
npx nx run doric-renderer:typecheck
npx nx run doric-renderer:test
npx nx run doric-renderer:build
```
