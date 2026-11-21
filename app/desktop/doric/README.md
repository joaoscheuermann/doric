# Doric desktop

`doric-app` is the Electron main process of the Doric desktop app. It owns what must work before and without any bundle: the `doric://app` origin, native windows and menus, the bridge to a Doric host, the verified artifact cache, one utility process per desktop generation, the single IPC dispatcher every window talks through, and the splash and recovery window. Which windows open, their sizes, the menu and the whole UI belong to bundles: the core bundle's `desktopMain` part decides the windows and the menu, and the client bundles draw each window ([`app.ts`](src/platform/app.ts), [`main.ts`](src/main.ts)).

For the product overview and setup, start with the [main README](../../../README.md). The shell each window loads is built by [`doric-renderer`](../doric-renderer/README.md); the host the app connects to is [`doric-host`](../../backend/doric-host/README.md). The feature docs that rely on this app are listed under [Related documents](#related-documents).

## Build, run and test

### Development

Start a host first, the real one ([host README](../../backend/doric-host/README.md)) or the in-memory [development fake host](../../../scripts/fake-host/README.md), then run from the repository root:

```console
npm run doric:dev
```

The script builds the generation runner (`nx run doric-app:build-runner`), then runs two processes with `concurrently --kill-others --success first`: `nx serve doric-renderer`, the renderer dev server on port 4200, and `wait-on tcp:127.0.0.1:4200 && nx serve doric-app`, which starts Electron once that port answers ([`package.json`](../../../package.json)).

`nx serve doric-app` runs [`serve.mjs`](serve.mjs), which starts `nx run doric-app:serve-electron` (an `nx-electron:execute` launch of `doric-app:build`). `serve.mjs` adds `--args=--no-sandbox` to that launch only when the effective user id is 0 (`process.getuid() === 0`, a root container for instance) or when `DORIC_ELECTRON_NO_SANDBOX` is exactly `1`; in every other case Electron keeps Chromium's sandbox. Chromium refuses to run as root with its sandbox, and Electron aborts before any app code runs in that case. `serve-electron` run directly and a packaged app never add the flag. `serve.mjs` forwards `SIGINT` and `SIGTERM` to its child and exits with the child's exit code, with 1 when the child ended with neither a code nor a signal, and with 128 when it ended on a signal ([`serve.mjs`](serve.mjs), [`project.json`](project.json)).

### Configuration

| Setting                     | Default                 | Effect                                                                                                                                                                                             |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DORIC_HOST_URL`            | `http://127.0.0.1:3000` | The host origin. The bridge, the connection status and every view window resolve against it ([`main.ts`](src/main.ts), [`host-bridge.ts`](src/platform/bridge/host-bridge.ts)).                    |
| `DORIC_RENDERER_DEV_URL`    | `http://localhost:4200` | The renderer dev server an unpackaged run forwards the shell from ([`main.ts`](src/main.ts), [`dev-proxy.ts`](src/platform/protocol/dev-proxy.ts)).                                                |
| `DORIC_ELECTRON_NO_SANDBOX` | unset                   | `1` makes the `serve` target start Electron with `--no-sandbox` without being root ([`serve.mjs`](serve.mjs)).                                                                                     |
| `DORIC_THEME`               | unset                   | In an unpackaged run, exactly `light`, `dark` or `system` overrides the saved theme; any other value, and every packaged run, ignores it ([`appearance.ts`](src/platform/appearance.ts)).          |
| `DORIC_SPLASH_ART`          | unset                   | In an unpackaged run, `shaded` makes the splash show its pre-shaded image instead of shading a photograph live ([`splash/window.ts`](src/platform/splash/window.ts)).                              |
| `NODE_ENV`                  | unset                   | `production` makes `build-runner` minify and drop source maps ([`build-runner.mjs`](build-runner.mjs)).                                                                                            |
| `--recovery` (argument)     | absent                  | The splash stops in the recovery state after the first successful load ([startup sequence](#startup), [`distribution.ts`](src/platform/catalog/distribution.ts), [`app.ts`](src/platform/app.ts)). |

"Unpackaged" is Electron's `app.isPackaged` being false.

### Nx targets

Run each from the repository root ([`project.json`](project.json)):

| Command                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx nx run doric-app:typecheck`    | `tsc --build` of the main process and preload (`tsconfig.app.json`) and of the runner and splash page (`tsconfig.runner.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npx nx run doric-app:lint`         | `biome check app/desktop/doric --formatter-enabled=false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npx nx run doric-app:test`         | Compiles `tsconfig.spec.json` into `dist-tests/` and runs `node --test` over the compiled `tests/*.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npx nx run doric-app:build-runner` | `node app/desktop/doric/build-runner.mjs --out dist/app/desktop/doric/assets`. [`build-runner.mjs`](build-runner.mjs) takes `--out <dir>` (relative to the repository root; `dist/app/desktop/doric/assets` when absent) and builds with esbuild the generation runner (`generation-runner.mjs`, `generation-runner-main.mjs`, `generation-contracts.mjs` and their shared `generation-chunks/`, ESM for Node 22, `zod` and `electron` external) and the splash page (`platform/splash@<v>/`, `<v>` being the runtime's `PLATFORM_ASSETS_VERSION`, [`version.ts`](../../../packages/bundle/src/runtime/version.ts)). |
| `npx nx run doric-app:build`        | Webpack build of `main.js` and `preload.js` into `dist/app/desktop/doric`, with `assets/legacy-origin.html` copied from `src/assets/`, after `^build`, `doric-platform:build` (the platform's import map, packages, tokens, theme and schemas under `assets/`) and `build-runner`.                                                                                                                                                                                                                                                                                                                                   |
| `npx nx run doric-app:serve`        | [`serve.mjs`](serve.mjs), above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `npx nx run doric-app:package`      | A prepackaged app (with the `doric-renderer` build) in `dist/packages`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npx nx run doric-app:make`         | Installers in `dist/executables`, product name `Doric` ([`maker.options.json`](src/app/options/maker.options.json)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npx nx run doric-app-e2e:e2e`      | The end-to-end suite of the desktop app, in its own project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The built main process finds its files beside `main.js`: `preload.js`; `assets/legacy-origin.html`, the empty page the storage copy reads from under `file://`; `assets/platform/` (platform packages, `importmap.platform.json`, `desktop@<v>/tokens.json` and `theme.css`, the splash); `assets/schemas/`; the runner under `assets/`; and the renderer build in `../doric-renderer/` ([`resources.ts`](src/platform/protocol/resources.ts), [`app.ts`](src/platform/app.ts), [`project.json`](project.json)).

## Startup

[`main.ts`](src/main.ts) registers the `doric` scheme as privileged before the app is ready ([`privileges.ts`](src/platform/protocol/privileges.ts)), then, inside `app.whenReady().then(…)`:

1. Builds the platform with the host URL, `userData`, `app.isPackaged`, the command line and Electron's notifications. The constructor reads `assets/platform/desktop@<v>/tokens.json` and `assets/platform/importmap.platform.json` synchronously; when one is missing or invalid it throws, the `whenReady` callback rejects, and nothing handles it: no splash or window opens and the code does not quit the app ([`app.ts`](src/platform/app.ts), [`tokens.ts`](src/platform/tokens.ts), [`import-map.ts`](src/platform/protocol/import-map.ts)).
2. `prepare()`: deletes `userData/artifacts/` if it exists (recursively; a symlink there is removed, never followed) ([`artifacts-cleanup.ts`](src/platform/artifacts-cleanup.ts)); opens `state.json`, `appearance.json` and `windows.json`; sets `nativeTheme.themeSource` from the saved theme; registers the `doric` protocol handler and the `doric:desktop` IPC handler; and starts following the bridge status ([`app.ts`](src/platform/app.ts)).
3. Opens the window-status connection and attaches it to `doric.shell/v1.connection` ([`main.ts`](src/main.ts), [`status.ts`](src/connection/status.ts)).
4. `start()`: opens the splash and runs the startup sequence below, then subscribes to `doric.catalog/v1.watch` on the host ([`app.ts`](src/platform/app.ts)).

The startup sequence ([`distribution.ts`](src/platform/catalog/distribution.ts)):

1. **Connect.** While the bridge is not connected, every failed attempt shows the host-unreachable state. "Open last known composition" switches to the `disconnected-copy` mode when a catalog snapshot exists.
2. **Load** one generation in the current mode (below). A thrown error shows the recovery state with its message; a core that does not activate shows the core-failure state; bundles the desktop quarantined although the host did not show the bundle-failure state. Each waits for an action, which picks the mode of the next load ([actions](#the-splash-and-recovery-window)).
3. **`--recovery`.** On the first successful load with the flag, the recovery state "Recovery was requested with --recovery." waits for an action. Any action clears the flag. Retry loads again in the same mode; any other action switches to the mode it picks, then loads again.
4. **Hold** the splash until at least 5 seconds have passed since the sequence started ([`timing.ts`](src/platform/splash/timing.ts)).
5. **`onAppReadyHook`** of `doric.app.hooks/v1` runs in the newest generation. The core answers it by opening its windows through `doric.windows/v1` (see the [core README](../../../bundles/foundation/core/README.md)). A failure of the hook is logged.
6. **First window ready.** The first window that calls `ready()` closes the splash. A `ready()` that arrived before step 5 closes the splash as soon as the hook starts. Otherwise a 30-second deadline starts when the hook starts; when it passes with no window ready, the splash shows the recovery state "No window became ready."; Retry runs `onAppReadyHook` again, and any other action switches to the mode it picks and reloads ([the reload](#the-reopened-splash-and-the-reload)).

### Load modes

A load reads a catalog, makes sure every listed file of every candidate bundle that is not `disabled` is in the artifact cache, resolves the desktop environments and starts the generation's process ([`app.ts`](src/platform/app.ts)). The splash shows `Reading the catalog`, then `Verifying bundles`, then `Downloading bundles (done/total)` as soon as one file needs a download, then `Activating` ([`splash/protocol.ts`](src/platform/splash/protocol.ts)).

| Mode                | Catalog                                                          | Candidates                                                                                                                                                                                                                                                                     | Artifacts                                                          | Host calls from windows               |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------- |
| `connected`         | `doric.catalog/v1.distribution()` from the host                  | Every bundle                                                                                                                                                                                                                                                                   | Missing files fetched with `doric.catalog/v1.artifact({ sha256 })` | Allowed while the bridge is connected |
| `disconnected-copy` | `doric/catalog-snapshot.json`                                    | Every bundle                                                                                                                                                                                                                                                                   | Cached files only                                                  | `unavailable`                         |
| `last-good-core`    | The live catalog when the bridge is connected, else the snapshot | The foundation bundles (the entries of the catalog's `host.bundles` with `phase: 'foundation'`) and the last core that worked, whose stored entry replaces the catalog's; the composition's core is that core, and its `enabled` list and `providers` map are cut to those ids | Cached files only                                                  | `unavailable`                         |

A missing snapshot fails the disconnected modes with `not_found` ("No catalog snapshot was saved yet."), and a missing last core with `not_found` ("No core has activated yet.") ([`app.ts`](src/platform/app.ts), [`resolve.ts`](src/platform/catalog/resolve.ts)).

In `connected` mode, right after resolution and before any process starts, whatever the load's outcome, main reports every bundle the desktop quarantined although the host did not, and that has a `desktopMain` or `client` part, with `doric.diagnostics/v1.report` (`kind: 'desktop_quarantine'`, the reasons' messages joined with `; ` as the message, `{ version, reasons }` as details). The report is not awaited; a failure is logged "Desktop quarantine report failed" ([`app.ts`](src/platform/app.ts), [`resolve.ts`](src/platform/catalog/resolve.ts)). After a `connected` generation activates, its catalog is saved as the snapshot (a failure is logged). When the core's `desktopMain` part is `active` after activation, the core becomes the last core that worked and is written to `state.json` ([`app.ts`](src/platform/app.ts)).

## The artifact cache and resolution

Every distributed file of a bundle lands in `userData/bundles/<id>@<version>/<path>` ([`artifacts.ts`](src/platform/catalog/artifacts.ts)):

- A cached file whose SHA-256 equals the catalog's is kept. Any other is fetched by hash, checked, written to `bundles/.tmp/`, synced and moved into place with a rename, so no partial file is ever served.
- A path that leaves the bundle directory, a failed download, a hash mismatch or a failed write is recorded as a failure of that file (`download_failed` or `hash_mismatch`), and the load goes on.
- Each failure quarantines its bundle with the reason `invalid_part` when the environments are resolved ([`resolve.ts`](src/platform/catalog/resolve.ts)).

`desktopMain` and `client` are resolved from the same candidates and composition with the runtime's resolver against this platform's version (`PLATFORM_VERSION`, `1.11.0`); the host's quarantines carry over ([`resolve.ts`](src/platform/catalog/resolve.ts), [`version.ts`](../../../packages/bundle/src/runtime/version.ts)).

The cache serves a file under `/bundles/` only while a retained generation lists it. When a generation is released, `bundles/<id>@<version>` directories that no retained generation and not the last core that worked reference are deleted, and so is `.tmp` ([`artifacts.ts`](src/platform/catalog/artifacts.ts), [`app.ts`](src/platform/app.ts)).

## Generations

A generation is one resolution of one catalog, numbered by a local counter. When a load repeats the mode and the host key (`hostId`, `hostBoot` and the host generation) of a generation that is still live, it gets that generation's number, and every load starts a new process ([`app.ts`](src/platform/app.ts)). With a reused number:

- the new process's entry replaces the live one, and the earlier process is not stopped; its menu registrations stay under the number;
- the new load's bundles take over the cache's retention for the number, and a failed activation releases it, after which the protocol stops serving the live generation's files until a later load retains them;
- windows pinned to the number reach the new process.

This happens on Retry after `--recovery`, on Retry in the bundle-failure state, on an action in the "No window became ready." state that keeps the mode (Retry there runs `onAppReadyHook` again and loads nothing), and on the reload after a primary window's core failure ([`distribution.ts`](src/platform/catalog/distribution.ts)).

### The `desktopMain` process

Each generation runs its `desktopMain` parts in one Electron `utilityProcess` ([`app.ts`](src/platform/app.ts), [`process.ts`](src/platform/generation/process.ts)):

- **Spawn.** `utilityProcess.fork(assets/generation-runner.mjs, ['--doric-runner=<base64 JSON>'])` with the service name `Doric desktopMain g<generation>` and inherited stdio. The JSON holds `imports` (bare specifier to `file://` URL: the platform map's entries, `bundle/contracts` pointed at the generation's own `generation-contracts.mjs`, and `<id>/contracts` of each bundle that ships one), `parts` (bundle id to the `file://` URL of each scheduled `desktopMain` part) and `moduleRoots` (the platform root and the artifact cache, whose `.js` files load as ES modules) ([`module-hooks.ts`](src/platform/generation/module-hooks.ts)).
- **Runner.** The process registers a Node resolve hook for those imports, then runs the runtime's `runGeneration` over `process.parentPort` (messages structured-cloned by Electron), importing each part's `activate` ([`runner-bootstrap.ts`](src/platform/generation/runner-bootstrap.ts), [`runner-entry.ts`](src/platform/generation/runner-entry.ts), [`electron-transport.ts`](src/platform/generation/electron-transport.ts)).
- **Control messages** ([`process.ts`](src/platform/generation/process.ts), [`messages.ts`](../../../packages/bundle/src/runtime/envelope/messages.ts)):
  - main → process: `init { init }`, where `init` is `{ environment: 'desktopMain', generation, incarnation, platformVersion, composition, entries, order, contracts, preActive: [], kernelProviders, hooksProvider: 'local', catalog }` (`kernelProviders` are the descriptors of main's platform providers below; `catalog` is the catalog snapshot); `stop`.
  - process → main: `provide { descriptor }` (main registers the provider, replacing one with the same key; a refused one is logged "Generation provider refused"); `unprovide { contractId, bundleId, key? }`; `diagnostics { snapshot }`; `platform-log { level, fields, message }` (written to the platform log with the generation); `ready { order }`. Other control messages are ignored.
- **Activation result.** A resolution whose `desktopMain` environment is already in recovery is a core failure with its reason, and no process starts. `ready` with diagnostics in `recovery` mode is a core failure with the diagnostics' reason; an exit before `ready` is a core failure "The desktopMain process exited with code … before it was ready.". A failed activation stops the process within 1 second and releases the generation's files ([`process.ts`](src/platform/generation/process.ts), [`app.ts`](src/platform/app.ts)).
- **Loss.** A process that exits after `ready` is logged, its menu entries are dropped, and it is respawned once per generation; `onAppReadyHook` does not run again. A second loss is not respawned ([`process.ts`](src/platform/generation/process.ts)).
- **Stop.** Main sends `stop` and kills the process when it has not exited after 10 seconds ([`process.ts`](src/platform/generation/process.ts)).
- **Bundle states.** When pushed diagnostics show a bundle not `active`, its menu items and keybindings are dropped ([`app.ts`](src/platform/app.ts)).

### A new host generation

Main subscribes to `doric.catalog/v1.watch` at the end of `start()` and on each reconnection after `onAppReadyHook`, while the bridge is connected. When the stream ends, main does not subscribe again until the next reconnection. On each `watch` event and each such reconnection, main reads the distribution and loads it as a generation when there is no newest generation, the newest is not in `connected` mode, or its host key differs; it then runs `onGenerationReadyHook` in the new process. Refreshes that overlap share one run. Open windows stay on the generation they loaded and nothing reloads. A failed refresh, or a load that does not activate, is logged ([`app.ts`](src/platform/app.ts)).

A window is pinned to the generation its shell was rendered with ([the dispatcher](#the-dispatcher)). A generation that is not the newest stops once no window pins it: its menu skeleton and entries are dropped, its files are released, its process is stopped and the cache is collected ([`app.ts`](src/platform/app.ts)).

## The splash and recovery window

The splash is a frameless, non-resizable 610×487 window with rounded corners, the window background color and the app's preload, at `doric://app/platform/splash@<v>/index.html` (with `?art=shaded` under `DORIC_SPLASH_ART=shaded`), where `<v>` is the runtime's `PLATFORM_ASSETS_VERSION` (`1.0.0`), the version of the shell's path too ([`resources.ts`](src/platform/protocol/resources.ts), [`version.ts`](../../../packages/bundle/src/runtime/version.ts)). It cannot navigate away or open windows, and it has no key: no bundle sees it ([`splash/window.ts`](src/platform/splash/window.ts)). Its page is plain DOM, without React ([`splash.ts`](src/splash-page/splash.ts), [`index.html`](src/splash-page/index.html)):

- An art pane: one of three bundled photographs, picked at random, shaded live with WebGPU when an adapter and a device arrive within 1 second and the photograph decodes; otherwise, on any later failure or a lost device, the pre-shaded `art-shaded.webp`. A change of the device pixel ratio redraws ([`choose-art.ts`](src/splash-page/art/choose-art.ts), [`run-effect.ts`](src/splash-page/art/run-effect.ts)).
- The Doric wordmark, the status line, details, actions, `© 2026 João Vitor Scheuermann`, `MIT License · v<app version>` (from `describeWindow().app.version`), and a GitHub link.

### `doric.splash/v1`

The page subscribes to `state` and calls `act(action)`, both with `bundleId: null`; any other contract or method from the splash fails `unavailable`, and a `catalog` request from the splash throws "The splash has no catalog." ([`splash/protocol.ts`](src/platform/splash/protocol.ts), [`dispatcher.ts`](src/platform/bridge/dispatcher.ts)). `state` sends the current state first, then every change; the first state is `{ state: 'loading', step: 'connecting' }`, shown as `Connecting to the host` ([`splash/state.ts`](src/platform/splash/state.ts)).

`SplashState` is one of:

- `{ state: 'loading', step, progress? }`, with `step` one of `connecting`, `catalog`, `download`, `verify`, `activation` and `progress` `{ done, total }`;
- `{ state: 'host-unreachable', hostUrl, lastError, attempts, hasSnapshot }`, with `lastError` the bridge's error or "The connection was refused.";
- `{ state: 'bundle-failure', bundles: [{ id, version, reasons: [{ code, message }] }] }`;
- `{ state: 'core-failure', core: { id, version }, error, hasLastGoodCore }`;
- `{ state: 'recovery', reason, diagnostics?, hasLastGoodCore }`.

`act` takes exactly one of these strict objects; anything else fails `invalid_input` ([`splash/state.ts`](src/platform/splash/state.ts)):

- `{ action: 'retry' }`: in `host-unreachable`, an immediate reconnection attempt; elsewhere, the same load again (from `last-good-core`, back to `connected`).
- `{ action: 'open-last-known' }`: the `disconnected-copy` mode.
- `{ action: 'continue' }`: goes on without the quarantined bundles.
- `{ action: 'disable', bundleId }`: `doric.catalog/v1.disable({ bundleId })` on the host, then a `connected` load.
- `{ action: 'reset-composition' }`: `doric.catalog/v1.resetComposition()` on the host, then a `connected` load. What the host stores for both is in the [host README](../../backend/doric-host/README.md).
- `{ action: 'use-last-good-core' }`: the `last-good-core` mode, when a last core exists; the same mode otherwise.
- `{ action: 'open-link', link: 'github' }`: main maps the name `github` to `https://github.com/joaoscheuermann/doric` and opens it in the system browser. The page's link carries that URL as its `href`, but its click handler cancels the navigation and sends only the name, so the URL that opens is main's ([`splash.ts`](src/splash-page/splash.ts), [`index.html`](src/splash-page/index.html), [`dispatcher.ts`](src/platform/bridge/dispatcher.ts)).

An action that arrives while none is awaited is ignored, except Retry in `host-unreachable` and `open-link`, which the dispatcher handles at any time ([`dispatcher.ts`](src/platform/bridge/dispatcher.ts)). An action whose host call fails is logged "Recovery action failed" and the same mode is loaded again ([`distribution.ts`](src/platform/catalog/distribution.ts)).

What each state shows ([`view.ts`](src/splash-page/view.ts)):

| State              | Status line                     | Details                                          | Actions, in order                                                                     |
| ------------------ | ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `loading`          | The step's text, with a spinner | None                                             | None                                                                                  |
| `host-unreachable` | `Cannot reach <host URL>`       | `<last error> · Attempt <n>`                     | `Retry`; `Open last known composition` when a snapshot exists                         |
| `bundle-failure`   | `Some bundles cannot load`      | One item per bundle: `<id> <version>: <reasons>` | `Retry`, `Continue without them`, one `Disable` per bundle                            |
| `core-failure`     | `<core id> <core version>`      | The error                                        | `Retry`; `Use last core that worked` when one exists; `Return to default composition` |
| `recovery`         | The reason                      | Each quarantined bundle with its first reason    | `Retry`; `Use last core that worked` when one exists; `Return to default composition` |

### The reopened splash and the reload

When the primary window reports a `core` failure, the splash opens again over the open windows (or, when it is still open, is focused) in the core-failure state, with the bundle the report names (else the core of the window's generation) and the report's message ([`app.ts`](src/platform/app.ts), [`distribution.ts`](src/platform/catalog/distribution.ts)). The chosen action picks a mode and reloads. When this happens after `onAppReadyHook` started and before the first `ready()`, the 30-second deadline keeps running: when it passes, the state "No window became ready." replaces the core-failure state and the core-failure action is no longer awaited, and a window's `ready()` before it passes closes the splash while the action is still awaited. Only the action of the newest state is handled ([`distribution.ts`](src/platform/catalog/distribution.ts)).

The reload follows an action on a reopened core-failure state and every action but Retry on the "No window became ready." state. It loads one generation in the picked mode without waiting for the bridge (a `connected` load while the bridge is down fails its `distribution()` call with "Doric backend is unavailable." and shows `recovery` with that reason) ([`distribution.ts`](src/platform/catalog/distribution.ts), [`app.ts`](src/platform/app.ts), [`host-bridge.ts`](src/platform/bridge/host-bridge.ts)):

- A generation that activates becomes the current mode, and `onAppReadyHook` runs in it at once: the 5-second minimum does not apply, bundles the desktop quarantined do not show the bundle-failure state, and `--recovery` is not shown again.
- A core that does not activate shows the core-failure state; any other failure shows `recovery` with the error as its reason and no diagnostics, so its details list no bundle. Each waits for an action, which picks the mode of the next reload.

Only the first `ready()` of the app's run closes the splash. A splash reopened after it closes therefore stays open: a later window's `ready()` does not close it, and the 30-second deadline does not show `recovery` for it. After a reload whose generation activates, the splash keeps showing the reload's last loading step, and no action is awaited, so every action but `open-link` is ignored. Until the first `ready()`, a reload whose generation activates arms the 30-second deadline again ([`distribution.ts`](src/platform/catalog/distribution.ts)). The mechanism is described in [Splash and recovery](../../../docs/architecture/bundles/splash-and-recovery.md).

## The `doric://app` origin

Every app window and the splash load only `doric://app/<path>`, a scheme registered as standard, secure, with the Fetch API, CORS and code cache ([`privileges.ts`](src/platform/protocol/privileges.ts), [`scheme.ts`](src/platform/protocol/scheme.ts)). The handler routes on the path only ([`handler.ts`](src/platform/protocol/handler.ts)):

| Path                                  | Answer                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/platform/shell@<v>/<file>`          | The renderer build; unpackaged, forwarded to the renderer dev server (a failure is a 404).                                        |
| `/platform/splash@<v>/index.html`     | The splash page, with the splash policy.                                                                                          |
| `/platform/<pkg>@<version>/<file>`    | Platform files under `assets/platform/`.                                                                                          |
| `/schemas/<file>`                     | Platform schemas under `assets/schemas/`.                                                                                         |
| `/bundles/<id>@<version>/<file>`      | A verified artifact listed by a retained generation.                                                                              |
| `/papercraft-modules/<sha256>/<file>` | A file under `userData/papercraft/<sha256>/`, the papercraft bundle's verified modules.                                           |
| `/frame/index.html`, `/frame/boot.js` | The preview frame document and its boot script.                                                                                   |
| Any other path                        | The shell document, for a navigation only. A request that does not accept HTML, or whose last segment has an extension, is a 404. |

A path segment that is empty, `.` or `..`, or holds NUL, `/` or `\` once decoded, a path that resolves outside its root, and a missing file are 404 `Not found`, never the shell. Content types come from the file extension ([`handler.ts`](src/platform/protocol/handler.ts), [`mime.ts`](src/platform/protocol/mime.ts)).

- **The shell document** is rendered per request: the template (`shell.html`, read once and kept when packaged, fetched from the dev server's `/platform/shell@<v>/shell.html` each time unpackaged) gets, as the first children of `<head>`, `<meta name="doric-generation">` with the newest generation (absent before the first one), an import map (the platform map plus `<id>/contracts` of every bundle of that generation that ships one) and the platform's `theme.css`. When the template cannot be read, or the dev server does not answer `2xx` ("The renderer dev server answered <status> for shell.html."), the error is not caught: the handler's promise rejects and the navigation fails; a packaged run reads the file again on the next request ([`shell.ts`](src/platform/protocol/shell.ts), [`dev-proxy.ts`](src/platform/protocol/dev-proxy.ts), [`import-map.ts`](src/platform/protocol/import-map.ts)).
- **Content security policy** ([`csp.ts`](src/platform/protocol/csp.ts)):
  - Packaged shell: `default-src 'none'; script-src 'self' 'sha256-<import map>'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src doric://app/frame/; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  - Unpackaged shell: `default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-<import map>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src doric://app/frame/; connect-src 'self' <dev server origin with ws>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  - Splash: the packaged policy without the hash and without `frame-src`.
  - Preview frame: `default-src 'none'; script-src doric://app 'sha256-<frame import map>'; style-src doric://app 'unsafe-inline'; font-src doric://app; img-src doric://app data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors doric://app`.
- **The preview frame.** `/frame/index.html` carries an import map with only React, ReactDOM and Base UI, and `boot.js` imports the module its `?entry=` names only when it is `doric://app/bundles/<id>@<semver>/client/frames/<name>.js`. A frame's origin is opaque, so `/frame/*`, `/platform/*`, `/papercraft-modules/*` and `/bundles/<id>@<v>/client/frames/*` answer `Access-Control-Allow-Origin: *`; nothing else does ([`frame.ts`](src/platform/protocol/frame.ts), [`handler.ts`](src/platform/protocol/handler.ts)).

The full description is [The `doric://app` protocol](../../../docs/architecture/bundles/doric-protocol.md).

## Windows

Main opens windows only on request, through `doric.windows/v1` ([below](#platform-contracts-main-provides-to-a-generation)), and keeps them by key in a registry ([`native-windows.ts`](src/platform/windows/native-windows.ts), [`registry.ts`](src/platform/windows/registry.ts)). Two kinds exist:

- **Path windows** load `doric://app/<path>` in a `BrowserWindow` with the app's preload, `sandbox`, `contextIsolation` and no Node integration. The window shows on `ready-to-show`. Every main-frame navigation records its path for the key, and a main-frame document load unpins the window and ends its open calls and streams. The window may not navigate itself elsewhere, its subframes may only load `/frame/index.html`, and `window.open` is denied ([`native-windows.ts`](src/platform/windows/native-windows.ts), [`navigation-guard.ts`](src/platform/windows/navigation-guard.ts)).
- **View windows** show one page of the host: a `BaseWindow` filled by a `WebContentsView` in the session the request's `partition` names, with no preload and no bundle contracts. The path is resolved against the host URL; the page may navigate inside its own origin only, and `window.open` is denied. The title is the request's `title`, or the page title. The window shows at once ([`native-windows.ts`](src/platform/windows/native-windows.ts), [`view.ts`](src/platform/windows/view.ts)).

Native options come from the request's appearance ([`windows/appearance.ts`](src/platform/windows/appearance.ts)):

- Size: the requested size, 800×600 when none, clamped between 320×240 and the primary display's work area; `minWidth` and `minHeight` when given.
- Background: the named window color token, dark or light after `nativeTheme`. When the system theme changes, every `BrowserWindow` (path windows and the splash, not view windows) takes the `window` token's color ([`main.ts`](src/main.ts)).
- Title bar: `native` keeps the OS frame; `integrated` on macOS hides the bar and keeps the traffic lights visible at the token inset; `none` drops the frame.
- Chrome: each window's shell receives `{ titleBar, height, safeArea }`, with the left safe area reserved for the window buttons unless the title bar is `none` or the window is full screen; main pushes it again on entering and leaving full screen.

Only one window may be primary: opening a primary key while another key is primary, or asking for an open non-primary key as primary, fails `registration_conflict`; a request without the flag never demotes an open primary window. A `core` failure reported by the primary window reopens the splash ([`native-windows.ts`](src/platform/windows/native-windows.ts), [`app.ts`](src/platform/app.ts)).

**Closing** a path window runs two phases ([`close.ts`](src/platform/windows/close.ts), [`desktop.ts`](src/app/api/desktop.ts)):

1. Veto: main pushes `close-requested` `{ phase: 'close', forced, deadline: 0 }` and waits, without a deadline, for the window's answer `{ allow: true }` or `{ allow: false, reason }`. The preload runs the window's close handler whatever `forced` says; a window with no handler, or whose handler throws, allows. A denial keeps the window open and is logged "Window close denied".
2. Flush: main pushes `{ phase: 'flush', forced: false, deadline }` (epoch milliseconds, now + 1.5 s), waits for the answer or 1.5 seconds, then closes the window.

`forced` is `true` for a close requested while an earlier unforced veto is pending (that veto is dropped) and for any close while the app quits; it is a flag for the window only, and the protocol runs the same way. A close while a forced veto or a flush is in progress is ignored. On close, the window paths are written at once ([`native-windows.ts`](src/platform/windows/native-windows.ts)). On every platform but macOS, closing the last window quits the app ([`main.ts`](src/main.ts)).

How the core decides its windows is in [Windows](../../../docs/architecture/bundles/windows.md) and [Window appearance](../../../docs/architecture/bundles/window-appearance.md).

## The window boundary

### The preload

The sandboxed preload exposes exactly one namespace, `window.doric.desktop`, over two IPC channels: `doric:desktop` (`ipcRenderer.invoke`, requests) and `doric:desktop:push` (pushes from main) ([`preload.ts`](src/app/api/preload.ts), [`desktop.ts`](src/app/api/desktop.ts)). Every request carries the generation from the shell's `doric-generation` meta tag, read at call time. Its members:

| Member                                        | Request op                      | Result                                                                                                                                                     |
| --------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeWindow()`                            | `describeWindow`                | `{ key, kind, primary, path, generation, chrome, mode, tokens, app: { version } }`                                                                         |
| `ready()`                                     | `ready`                         | Marks the window ready; the first one closes the splash.                                                                                                   |
| `reportFailure({ kind, bundleId?, message })` | `reportFailure`                 | `kind` is `core` or `bootstrap`; logged, and a primary window's `core` failure reopens the splash.                                                         |
| `onCloseRequested(handler)`                   | answers with `closeAnswer`      | Registers the close handler (one per window).                                                                                                              |
| `onChromeChanged(listener)`                   | —                               | Follows `chrome` pushes.                                                                                                                                   |
| `catalog()`                                   | `catalog`                       | The window's `WindowCatalog`: its generation, client resolution, client part URLs (`entry`, `styles`), remote contracts, `hostId` and `storageGeneration`. |
| `call(envelope)`                              | `call`                          | `{ ok: true, output }` or `{ ok: false, error: { code, message, details? } }`; never a rejection for a contract error.                                     |
| `cancel(id)`                                  | `cancel`                        | Aborts an open call.                                                                                                                                       |
| `subscribe(envelope, listener)`               | `subscribe`, then `unsubscribe` | Items arrive as `event` pushes and the end as `end` (with an error when it failed); returns the unsubscribe function.                                      |

An envelope is `{ id, contract, method, input, bundleId, scope?, deadline, traceparent }`: `bundleId` is the calling client bundle, or `null` for the window platform; `deadline` is epoch milliseconds, `0` for none; `scope` may not hold `windowKey` ([`protocol.ts`](../../../packages/desktop/src/client/protocol.ts)).

### The dispatcher

One `ipcMain.handle('doric:desktop')` serves every window and the splash. Main is the trust point ([`dispatcher.ts`](src/platform/bridge/dispatcher.ts)):

1. **Sender.** The request must come from the main frame of a registered window or of the splash, at a `doric://app` URL; anything else throws "The request source is not allowed." ([`sender.ts`](src/platform/bridge/sender.ts)). A request that does not match the request schema throws `Invalid desktop request: …`.
2. **Pin.** The first `describeWindow` or `catalog` that names a generation pins the window to it. When main does not retain that generation, the window reloads (its shell is rendered again with the newest generation) and the request fails `unavailable`. A request from a window without a generation fails `unavailable` "This window has no generation."
3. **Resolve** a call or subscription with a `bundleId`, in this order:
   1. The bundle has an active client part in the window's generation; else `unavailable` (details `{ bundleId, generation }`).
   2. The contract is not `doric.*` and is in the bundle's `requires`, `provides` or `optional`; else `undeclared_requirement`.
   3. A provider of the contract with the method is reachable (`desktopMain` first, then host); else `unavailable`.
   4. The method is exposed with `expose: 'desktop'`; else `unavailable`.
   5. Every `scope` key is declared by the provider's manifest `desktopScope`; else `invalid_input`.
   6. The method is not local; else `local_only`.
   7. A `call` targets a call and a `subscribe` a stream; else `invalid_input`.
   8. The input matches the method's published JSON Schema (for a stream, the tuple without its listener); else `invalid_input`.
   9. A host route needs the `connected` mode and a connected bridge; else `unavailable` "Doric backend is unavailable.". A `desktopMain` route needs the generation's process alive with that provider; else `unavailable` "The desktopMain provider of … is not running.".
4. **Fill.** Main builds the call itself: the caller (`bundleId`, its version, the generation), the scope with `windowKey` set to the window's key, the trace and the deadline.
5. **Route** to the generation process's provider, or to the host over the bridge. A call's output is checked against the method's output schema (`invalid_output`); a stream's items are not.

Schemas are checked with Ajv for JSON Schema 2020-12 (`strict: false`, `validateFormats: false`, the first error only), each schema compiled once ([`validation.ts`](src/platform/bridge/validation.ts)). The routes and the `WindowCatalog` come from the bundles' `contracts.json` and schema files in the artifact cache; a contract whose exposure cannot be read is not routed ([`client-routing.ts`](src/platform/bridge/client-routing.ts)). A window's navigation or destruction ends its open calls and streams ([`dispatcher.ts`](src/platform/bridge/dispatcher.ts)).

### `doric.shell/v1`

A call or subscription with `bundleId: null` reaches the window platform's own contract, `doric.shell/v1`; any other contract fails `undeclared_requirement`, and a method that is not a call (for `call`) or not a stream (for `subscribe`) fails `invalid_input` ([`dispatcher.ts`](src/platform/bridge/dispatcher.ts)):

| Method          | Kind   | Input → behavior                                                                                                                                                      |
| --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `keybindings`   | stream | The window's effective keybinding table `[{ key, command }]` now and on every change.                                                                                 |
| `keybinding`    | call   | `{ key }`: runs the command bound to it in this window ([commands](#menus-keybindings-and-commands)); `not_found` when none is.                                       |
| `commands`      | stream | Requests `{ id, command, input }` main sends the window to run a client command.                                                                                      |
| `commandResult` | call   | `{ id, ok: true }` or `{ id, ok: false, error }`: the answer to a `commands` request.                                                                                 |
| `log`           | call   | `{ level?: 'info' \| 'warn' \| 'error', message, fields? }`: written to the platform log with the window key.                                                         |
| `diagnostic`    | call   | A `quarantine`, `report` or `recovery` diagnostic: written to the platform log at `info` with the window key.                                                         |
| `connection`    | stream | `connected` or `disconnected`: the current status, then every change.                                                                                                 |
| `openExternal`  | call   | `{ url }`, an https URL of at most 8192 characters, checked again here: opened in the system browser (`doric.browser/v1`); only the origin is logged.                 |
| `appearanceGet` | call   | `{ theme }`, the saved preference (`doric.appearance/v1`).                                                                                                            |
| `appearanceSet` | call   | `{ theme }` (`light`, `dark` or `system`): saved, then shown in every window; a failed save fails `unavailable` "Could not save the appearance." and changes nothing. |

## Platform contracts main provides to a generation

Main registers these services on its `doric` principal and hands their descriptors to each `desktopMain` process in `init`; the process's calls arrive with the caller's generation ([`broker.ts`](src/platform/generation/broker.ts), [`process.ts`](src/platform/generation/process.ts)). Their full shapes are in [Contracts](../../../docs/architecture/bundles/contracts.md) and the documents linked from each row.

| Contract                 | Methods and what main does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doric.windows/v1`       | `open(request)`: a path window (`path` must start with `/`) or a view window; an open key is focused (restored when minimized) and loaded again when its path differs; an empty key fails `invalid_input`; a load failure fails `unavailable`. `focusOrOpen(key)`: focuses, or reopens the key with this run's last request at its last path (`not_found` when never opened). `focus(key)`: `true` when an open window was focused. `lastPath(key)`: the stored path, `null` for a view window. `navigate({ key, path })`: a view window loads another host path (`not_found` when not open, `invalid_input` for a path window). `capture({ key, rect })`: a PNG (base64) of a CSS-pixel rectangle of a path window at its device pixel ratio, with `width`, `height` and `scale`; `invalid_input` for a view window or a rectangle outside the viewport, `unavailable` for an empty or failed capture ([`native-windows.ts`](src/platform/windows/native-windows.ts); [Windows](../../../docs/architecture/bundles/windows.md)). |
| `doric.menus/v1`         | `setSkeleton`, `add`, `addKeybinding`, `setContext` ([menus](#menus-keybindings-and-commands); [Menus and keybindings](../../../docs/architecture/bundles/menus-and-keybindings.md)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `doric.cache/v1`         | `directory()`: creates and returns `userData/bundle-cache/<bundleId>/` for the calling bundle, and `userData/papercraft/` for `papercraft`, the tree served under `/papercraft-modules/`; a bundle id outside `^[a-z][a-z0-9-]*$` fails `invalid_input` ([`cache.ts`](src/platform/native/cache.ts), [`app.ts`](src/platform/app.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `doric.migrations/v1`    | `storage({ key, marker })`: copies one `localStorage` key from the packaged `file://` origin to `doric://app` once ([below](#the-storage-copy)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `doric.tokens/v1`        | `get()`: the shared tokens, the default variant and the window variables (`--doric-titlebar-height`, `--doric-window-background`, `--doric-safe-*`) ([`tokens.ts`](src/platform/tokens.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `doric.notifications/v1` | `show({ title, body })`: one native notification ([below](#notifications)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `doric.log/v1`           | `write(record)`: one platform log line with the bundle, version, generation, environment, scope and trace; `debug` is written as `info`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Main runs the app lifecycle hooks of `doric.app.hooks/v1` (`onAppReadyHook`, `onAppActivateHook`, `onBeforeQuitHook`, `onConnectionChangedHook`, `onGenerationReadyHook`) through the generation's `hooks/v1` provider, as the `doric` caller. Without a provider or a live process, `onBeforeQuitHook` answers `{ allow: true }` and the others do nothing ([`process.ts`](src/platform/generation/process.ts), [`app.ts`](src/platform/app.ts); [Hooks](../../../docs/architecture/bundles/hooks.md)).

### The storage copy

`doric.migrations/v1.storage({ key, marker })` never rejects. It answers ([`storage-origin.ts`](src/platform/migration/storage-origin.ts)):

- `skipped` when `marker` is already recorded in `state.json`;
- `skipped`, recording the marker, in an unpackaged run;
- otherwise main opens a hidden, sandboxed, context-isolated window at the `file://` URL of `assets/legacy-origin.html` and reads `localStorage.getItem(key)`. When the value is not a string, it records the marker and answers `none`. Else it opens a second hidden window at `doric://app/platform/splash@<v>/blank.html` and sets the key there only when it is unset, records the marker and answers `migrated`;
- `failed` when any step throws: the error is logged "Storage origin migration failed" and the marker is still recorded.

Both hidden windows are destroyed at the end. The mechanism is described in [The `doric://app` protocol](../../../docs/architecture/bundles/doric-protocol.md).

## The host bridge and the connection status

**The bridge** is one Socket.IO client on the namespace `/doric/bridge` of the host URL (trailing slashes removed), websocket transport only, reconnecting every second without randomization. When the server refuses the connection itself, which Socket.IO does not retry, main tries again after one second ([`host-bridge.ts`](src/platform/bridge/host-bridge.ts)):

- A call is emitted as `call` with the whole envelope message `{ kind: 'call', id, contract, method, input, caller, scope?, trace, deadline, generation }`; the host answers `result` `{ id, ok, output | error }`. A subscription is `subscribe`, answered by `event` `{ id, values }` and `end` `{ id, error? }`; `cancel` and `unsubscribe` carry `{ kind, id }`. Ids are `d:c<n>` and `d:s<n>`.
- Without a connection, a call fails `unavailable` "Doric backend is unavailable." and a subscription ends `disconnected` "The host bridge is not connected.". A call whose deadline passes is cancelled and fails `unavailable`. A disconnection fails every pending call with `unavailable` and ends every stream with `disconnected` "The host bridge disconnected.".
- Every status change runs `onConnectionChangedHook` with `{ connected }`, once per actual change ([`lifecycle.ts`](src/platform/lifecycle.ts)).

**The connection status** windows follow through `doric.shell/v1.connection` comes from a second Socket.IO connection to the same namespace on its own manager (websocket, reconnecting): `connect` reads `connected`, `disconnect` and `connect_error` read `disconnected`, and repeated values are dropped. Windows read `disconnected` until it is attached ([`manager.ts`](src/connection/manager.ts), [`status.ts`](src/connection/status.ts), [`relay.ts`](src/connection/relay.ts)).

## Menus, keybindings and commands

Main keeps, per generation, the menu skeleton and the items and keybindings each bundle registered, and per window a context `{ path, focus }` ([`native-menus.ts`](src/platform/menus/native-menus.ts), [`skeleton.ts`](src/platform/menus/skeleton.ts)):

- `setSkeleton(skeleton)` stores the generation's skeleton. A generation that never set one uses the last skeleton set. Before any skeleton, Electron's default menu stays.
- `add({ id, location, command, label, when?, order? })`: `location` is `app/<menu id>` or `dock`. A second item with the same id from the same bundle in the generation fails `registration_conflict`. Items sort by `order`, then by the order their bundles first registered.
- `addKeybinding({ command, key, when? })`: a key already bound with the same `when` in the generation fails `registration_conflict`.
- `setContext({ windowKey, key: 'path' | 'focus', value })` sets a window's context (`not_found` for a closed key). An item or binding applies when each field of its `when` equals the context.

The application menu is rebuilt for the focused window's generation (the newest when none is focused) whenever focus, registrations, context or pins change. Each skeleton entry becomes a menu: a role entry is Electron's own submenu, extended after a separator with the contributed items; `appMenu` appears on macOS only; `help` appears only when something is contributed to it. An item shows the key of the binding for its command as an accelerator without registering it. On macOS, `dock` items form the dock menu ([`native-menus.ts`](src/platform/menus/native-menus.ts), [`skeleton.ts`](src/platform/menus/skeleton.ts)).

A command from a menu item or a keybinding is dispatched for its window (the focused one for the menu) ([`app.ts`](src/platform/app.ts), [`dispatcher.ts`](src/platform/bridge/dispatcher.ts)):

1. `commands/v1.execute(command, {})` in the window's generation's `desktopMain` process, with the window key in scope.
2. When that answers `unknown_command`, and the window subscribed to `doric.shell/v1.commands`, main sends it `{ id, command, input: {} }` and waits, without a deadline, for its `commandResult`.
3. When neither has the command, main logs `command_not_found`. Any other failure is logged as "Command failed".

## The app lifecycle

[`lifecycle.ts`](src/platform/lifecycle.ts) and [`main.ts`](src/main.ts) map Electron's app events to hooks of the newest generation:

- **Quit.** `before-quit` is held while `onBeforeQuitHook` decides. `{ allow: false, reason }` cancels the quit and logs "Quit denied". An allowed quit, a hook failure or an invalid answer writes the pending window paths and `state.json` (a write failure is logged), then quits. A second quit request while the hook runs forces the quit. While quitting, every window close is forced.
- **Activate.** `activate` with no app window runs `onAppActivateHook`, once `onAppReadyHook` has run.
- **Will quit.** The window-status connection closes; main stops the catalog watch, closes the bridge, stops every generation process and writes the window paths and state ([`app.ts`](src/platform/app.ts)).

## Theme

The theme preference is `light`, `dark` or `system`, kept in `userData/doric/appearance.json` as `{ "theme": … }` and `dark` when the file is missing or invalid ([`appearance-store.ts`](src/platform/appearance-store.ts)). Main sets `nativeTheme.themeSource` from it at `prepare()`, before the splash opens, and again after each `appearanceSet`; in an unpackaged run a valid `DORIC_THEME` wins over it, without changing what is saved ([`appearance.ts`](src/platform/appearance.ts), [`app.ts`](src/platform/app.ts)). The Appearance setting is described in [UI redesign](../../../docs/features/ui-redesign.md) and [Settings](../../../docs/features/settings.md).

## Notifications

`doric.notifications/v1.show` draws one native notification ([`notifications.ts`](src/platform/native/notifications.ts)). Which completions deserve a notice, and their text, is the [`notifications` bundle](../../../bundles/desktop/notifications/README.md)'s.

- The title and the body are trimmed and cut to 200 characters (code points) each before they reach the OS.
- An empty title, or a platform where `Notification.isSupported()` is false, draws nothing, silently.
- When Electron emits the notification's `failed` event, main writes `Doric: notification failed: <error>` to stderr and logs "Notification failed". On macOS the system refuses notifications from an app binary that is not code-signed, and reports the refusal through this event rather than by throwing, so an unsigned development build shows no notification and prints that line.

## Logging

The platform log writes one JSON line per record, `{ level, time, msg, ...fields }`: `info` to stdout, `warn` and `error` to stderr. An `Error` field is written as `{ name, message }`. Main keeps no log files, and a closed stdout or stderr does not crash it ([`log.ts`](src/platform/log.ts)).

## Local state

Under Electron's `userData` directory ([`paths.ts`](src/platform/paths.ts)). Every JSON file is written through a temporary file, `fsync` and a rename, and a missing or invalid file reads as its default ([`state.ts`](src/platform/state.ts)).

| Path                          | Contents                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundles/<id>@<version>/`     | Verified bundle artifacts; `bundles/.tmp/` is the download staging area ([`artifacts.ts`](src/platform/catalog/artifacts.ts)).                                                                                                                                                                                                                                  |
| `papercraft/<sha256>/`        | The papercraft bundle's verified modules, served under `/papercraft-modules/`.                                                                                                                                                                                                                                                                                  |
| `bundle-cache/<bundleId>/`    | Each bundle's `doric.cache/v1` directory.                                                                                                                                                                                                                                                                                                                       |
| `doric/state.json`            | `{ migrations: { <marker>: true }, lastGoodCore?: { id, version, generation, bundle } }`. Each marker matches `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`. A file with more than 32 markers is read as invalid, so it reads as the default `{ migrations: {} }`; writes do not check that count. Written on each change, serialized ([`state.ts`](src/platform/state.ts)). |
| `doric/windows.json`          | `{ lastPaths: { <window key>: <path> } }`: the last path per window key, no bounds. Written 250 ms after the last change, and at once when a window closes or the app quits ([`state.ts`](src/platform/state.ts)).                                                                                                                                              |
| `doric/catalog-snapshot.json` | The last distribution that activated in `connected` mode ([`snapshot.ts`](src/platform/catalog/snapshot.ts)).                                                                                                                                                                                                                                                   |
| `doric/appearance.json`       | `{ theme }` ([`appearance-store.ts`](src/platform/appearance-store.ts)).                                                                                                                                                                                                                                                                                        |

`userData/artifacts/` is deleted at every start before any window opens; nothing writes there ([`artifacts-cleanup.ts`](src/platform/artifacts-cleanup.ts)).

## Related documents

- Architecture: [The `doric://app` protocol](../../../docs/architecture/bundles/doric-protocol.md), [Splash and recovery](../../../docs/architecture/bundles/splash-and-recovery.md), [Windows](../../../docs/architecture/bundles/windows.md), [Window appearance](../../../docs/architecture/bundles/window-appearance.md), [Menus and keybindings](../../../docs/architecture/bundles/menus-and-keybindings.md), [Process isolation](../../../docs/architecture/bundles/process-isolation.md), [Composition and distribution](../../../docs/architecture/bundles/composition-and-distribution.md), [Contracts](../../../docs/architecture/bundles/contracts.md), [Hooks](../../../docs/architecture/bundles/hooks.md).
- Feature docs: [UI redesign](../../../docs/features/ui-redesign.md) (the splash and the Appearance setting), [Settings](../../../docs/features/settings.md), [Screen](../../../docs/features/screen.md) (view windows), [Papercraft](../../../docs/features/papercraft.md) (the preview frame and `/papercraft-modules/`), [Terminal](../../../docs/features/terminal.md), [OpenUI diagrams](../../../docs/features/openui-diagrams.md).
