# Doric desktop

`doric-app` owns the Electron main process. It loads `doric-renderer`, calls the
local Direct API at `http://127.0.0.1:3000`, and exposes only named Project and
Thread operations through a sandboxed, origin-checked preload bridge.

At startup a frameless, square, dark splash window shows the centered `Doric`
name while the main process waits for the local Direct API to answer. The splash
stays visible for at least five seconds, and the dark workspace window replaces
it once that window is ready to show.

On macOS the workspace window keeps always-visible native traffic lights over a
custom draggable renderer title bar.

## Development

Start the Direct backend first, then run both desktop development processes from
the repository root:

```console
npm run doric:dev
```

Build, test, or package the desktop boundary directly:

```console
npx nx run doric-app:typecheck
npx nx run doric-app:lint
npx nx run doric-app:test
npx nx build doric-app
npm run nxe:package:app
```

Project and Thread deletion terminates the resource before retrying physical
deletion until the asynchronous lifecycle reaches a terminal state.
