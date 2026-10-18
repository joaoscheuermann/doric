# Doric desktop

The Doric desktop app is where you work with your agents: it connects to a
Doric host, downloads and verifies the UI bundles that host serves, and opens
the workspace where you chat with agents, follow their child Threads, and
browse each Project's files and changes. This package, `doric-app`, is the
Electron main process — the technical platform under that UI. Read this if you
run the app in development, package it, or change what crosses the boundary
between a window and the main process.

For the product overview and setup, start with the
[main README](../../../README.md).

## What you see

### Splash and recovery

At startup a frameless 420×260 splash window shows the `Doric` name and one
status line while the app gets ready:

1. `Connecting to the host`
2. `Reading the catalog`
3. `Downloading bundles (done/total)`
4. `Verifying bundles`
5. `Activating`

The splash stays visible for at least five seconds, and the workspace window
replaces it once that window is ready to show.

When something goes wrong, the same window becomes the recovery surface:

| Situation                                | What it shows                | Actions                                                                                 |
| ---------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------- |
| The host does not answer                 | `Cannot reach <host URL>`    | `Retry`, and `Open last known composition` when a snapshot exists                       |
| Some bundles failed                      | Each bundle with its reasons | `Continue without them`, `Disable` per bundle, `Retry`                                  |
| The core bundle failed, or recovery mode | The core or the reason       | `Use last core that worked` (when one exists), `Return to default composition`, `Retry` |

The splash also turns into the recovery surface when a window is not ready
within 30 seconds. `Disable` and `Return to default composition` ask the host
to write or delete `composition.overrides.json` beside its composition; the
core cannot be disabled.

### The workspace

- The workspace window reopens at the last path it showed (the selected
  Thread is part of that path).
- On macOS, the window keeps always-visible native traffic lights over the
  app's own draggable title bar.
- Windows follow the system light or dark theme.
- The footer reports `Connected` or `Disconnected` from the main process's
  subscription to the host's `/status` Socket.IO namespace.

### Notifications

When a prompt finishes in a Thread you are not already reading in a focused
window, the app draws a native notification titled with the Thread's name and
naming the outcome (`Prompt completed`, `Prompt failed`, `Prompt cancelled`)
with a short preview of the answer.

- The `notifications` bundle decides whether a completion deserves a notice;
  the main process draws it, bounding each line to 200 characters before it
  reaches the OS.
- On a platform that supports no notifications, the notice is dropped in
  silence. A completion is durable in the Thread's log either way, so a
  missing notice never hides what happened.
- On macOS the system delivers notifications only for a code-signed app: the
  UNNotification API refuses an unsigned binary with a `failed` event rather
  than a throw, which the main process reports on the terminal
  (`Doric: notification failed: …`) so a development build is explained
  instead of merely silent.

## Development

Start a host first — the real one (see the
[host README](../../backend/doric-host/README.md)) or the in-memory
[development fake host](../../../scripts/fake-host/README.md) — then run both
desktop development processes from the repository root:

```console
npm run doric:dev
```

That builds the generation runner, serves `doric-renderer` on
`http://localhost:4200`, waits for it, and starts Electron through
`nx serve doric-app`.

| Variable                    | Default                 | Meaning                                                     |
| --------------------------- | ----------------------- | ----------------------------------------------------------- |
| `DORIC_HOST_URL`            | `http://127.0.0.1:3000` | The host the app's bridge and connection monitor reach.     |
| `DORIC_RENDERER_DEV_URL`    | `http://localhost:4200` | The renderer dev server the shell is forwarded from.        |
| `DORIC_ELECTRON_NO_SANDBOX` | unset                   | `1` starts Electron with `--no-sandbox` without being root. |

Chromium cannot use its setuid sandbox helper as root, so when the process runs
as root — a root container, for instance — the `serve` target starts Electron
with `--no-sandbox`; a normal user keeps the sandbox.

Build, test, or package the desktop boundary directly:

```console
npx nx run doric-app:typecheck
npx nx run doric-app:lint
npx nx run doric-app:test
npx nx build doric-app
npx nx run doric-app:package   # prepackaged app in dist/packages
npx nx run doric-app:make      # installers in dist/executables
npx nx run doric-app-e2e:e2e
```

## Architecture

The app owns only what must work without any bundle: the `doric://app`
protocol, native windows and menus, the bridge to the host, the verified
artifact cache, one generation process per desktop generation, the single IPC
dispatcher, and the splash and recovery surface. Which windows open, their
sizes, the menu and the whole UI belong to bundles: the core bundle's
`desktopMain` part and the client bundles (`layout`, `chat`, `settings` and the
feature bundles) that run in each window.

### Startup

1. Before any window, the splash downloads the host's
   `doric.catalog/v1.distribution()` over the host bridge Socket.IO namespace
   `/doric/bridge` and verifies each artifact's SHA-256 into the local cache.
2. The main process runs one Electron `utilityProcess` per desktop generation,
   executing the core's `desktopMain` part, which opens the window the core
   marks `primary` (the `workspace` key today) at the last path stored for
   that key.
3. Each window loads the shell built by
   [`doric-renderer`](../doric-renderer/README.md), which boots the client
   bundles.

An allowed quit waits for pending window-path and platform-state writes before
exiting.

### The `doric://app` origin

Every app window loads only `doric://app/<path>`, a privileged standard scheme
whose handler serves the shell, the platform files under `/platform/`, and the
verified bundle artifacts from the local cache with their schemas. A missing
file is a 404, never the shell. In development the windows still open through
`doric://app`, and the handler forwards the shell and its assets to the
renderer dev server. A view window loads a page from the host's own origin
instead and carries no preload.

### Main-process boundary

Windows are sandboxed and context-isolated. The preload exposes exactly one
namespace, `window.doric.desktop`, over two IPC channels: `doric:desktop` for
requests and `doric:desktop:push` for what main pushes back. Through it a
window can describe itself, report readiness or failure, answer close
requests, follow chrome changes, read the catalog, and make, cancel or
subscribe to contract calls. There is no semantic Project, Thread,
configuration or terminal API in the preload, and the window never opens HTTP
or Socket.IO itself.

One dispatcher handles every request. Main is the trust point:

- it checks that the sender is a `doric://app` page;
- it pins the window's generation and fills in the caller and the window key
  (a window may not send the key itself);
- it validates inputs and outputs against the published JSON Schemas;
- it routes each call to the window, the `desktopMain` generation, or the
  host.

A host method reaches a window only when its contract declares
`expose: 'desktop'`; everything else is denied.

Main itself provides the platform contracts a window or generation needs from
Electron:

- `doric.shell/v1`, including the `connection` status every window follows;
- `doric.windows/v1`, which focuses or navigates the window a key names;
- `doric.notifications/v1`, the one native notification function;
- `doric.cache/v1`, one cache directory per bundle;
- `doric.migrations/v1`, the one-time copy of a bundle's local storage from
  the packaged `file://` origin to `doric://app`.

### Local state

Under Electron's `userData` directory:

| Path                          | Contents                                                 |
| ----------------------------- | -------------------------------------------------------- |
| `bundles/`                    | Verified bundle artifacts (`<id>@<version>/…`).          |
| `artifacts/`                  | Verified artifact revisions, served under `/artifacts/`. |
| `bundle-cache/<bundleId>/`    | Each bundle's `doric.cache/v1` directory.                |
| `doric/state.json`            | Migrations and the last core that worked.                |
| `doric/windows.json`          | The last path per window key (no bounds).                |
| `doric/catalog-snapshot.json` | The last distribution that activated.                    |
