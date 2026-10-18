# Doric renderer shell

`doric-renderer` is the thin page every Doric desktop window loads. It holds no
product UI: it starts the window, loads the client bundles the host serves, and
lets them draw the workspace, the conversation and the settings. Read this if
you work on how windows boot, on window-wide styling, or on the renderer dev
server.

For the product overview, start with the [main README](../../../README.md); the
Electron main process that serves this shell is described in the
[desktop README](../doric/README.md).

## What it builds

`doric-app` serves this build from `doric://app/platform/shell@<version>/`:

- `shell.html`, the template main renders per request (import map, theme,
  CSP);
- the bootstrap script, which follows the system light or dark scheme and
  calls desktop/client's `bootstrapWindow({})`;
- the shell stylesheet, holding only window-wide rules and the sorted utility
  set;
- the favicon.

`bootstrapWindow({})` activates the generation's client bundles and puts the
core's `<core-outlet>` in the body. The route decides what it shows: `/` is the
`layout` bundle's workspace frame and `/settings` the settings page. The UI
itself lives in those bundles, not here.

## Boundary

The shell has no direct network access and no semantic API: the preload
exposes only `window.doric.desktop`, and every call is a contract call main's
dispatcher routes to the window, the `desktopMain` generation or the host.

## Development

Use the combined Electron workflow from the repository root:

```console
npm run doric:dev
```

The dev server (`http://localhost:4200`) answers `/platform/shell@<version>/*`;
the windows still open `doric://app` and main forwards the shell to it. Set
`DORIC_RENDERER_DEV_URL` to point main at another dev server.

Run the shell's checks with:

```console
npx nx run doric-renderer:typecheck
npx nx run doric-renderer:test
npx nx build doric-renderer
```
