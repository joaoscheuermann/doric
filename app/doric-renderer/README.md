# Doric renderer shell

`doric-renderer` builds the window shell `doric-app` serves from
`doric://app/platform/shell@<version>/`: `shell.html`, the bootstrap script,
the shell stylesheet and the favicon. The bootstrap calls desktop-client's
`bootstrapWindow({})`, which activates the generation's client bundles and puts
the core's `<core-outlet>` in the body; the route decides what it shows (`/`
is the layout's workspace frame, `/settings` the settings page).

The shell has no direct network access and no semantic API: the preload
exposes only `window.doric.desktop`, and every call is a contract call main's
dispatcher routes to the window, the desktopMain generation or the host.

## Development

Use the combined Electron workflow from the repository root:

```console
npm run doric:dev
```

The dev server (`http://localhost:4200`) answers `/platform/shell@<version>/*`;
the windows still open `doric://app` and main forwards the shell to it.

Run the shell's checks with:

```console
npx nx run doric-renderer:typecheck
npx nx run doric-renderer:test
npx nx build doric-renderer
```
