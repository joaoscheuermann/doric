# Windows

- Status: living document. It describes the windows of the desktop app as implemented on 2026-11-20.

## Summary

The Electron main process creates every window, keeps the preload and the IPC boundary, and decides nothing about which windows exist: no window is fixed in the main process and no manifest declares one. Bundle code opens windows through the platform contract `doric.windows/v1`, which only the desktop main process provides, in the `desktopMain` environment ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)).

A window is a stable **key** plus its content. The content is one of two kinds:

- an **app window** shows a path of the app: it loads the one shell page at `doric://app<path>`, and the path chooses the [route](navigation.md) the window's `<core-outlet>` shows;
- a **view window** shows a page of the host: it loads a host-relative path, resolved against the origin the app reaches the host on, in a session partition of its own, with no preload and no bundle contracts.

The core opens the primary `workspace` window when the app is ready and the `settings` window through its command `core.open-settings/v1`. Other bundles open windows through the core's service `windows/v1`, which prefixes the key with the calling bundle's id, or through `doric.windows/v1` itself. A window cannot open windows itself: every `window.open` is denied. Its client parts open one only through `windows/v1`, which the bridge carries to the core's `desktopMain` part. The window's only way out of the app is `doric.browser/v1`, which opens an `https:` page in the operating system's browser.

## Who opens windows

| Caller       | Contract                                         | Windows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core`       | `doric.windows/v1`                               | `workspace`, the primary app window, in `onAppReadyHook`, and `settings` in `core.open-settings/v1` ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`core/src/desktop/commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts))                                                                                                                                                                                                                                               |
| `papercraft` | `windows/v1`                                     | One app window per canvas, opened by the command `papercraft.open-canvas/v2`: key `papercraft:program:<threadId>/<identity>` after the core's prefix, path `/papercraft/<projectId>/<threadId>/<identity>` with each segment URI-encoded ([`papercraft/src/desktop/commands.ts`](../../../bundles/features/papercraft/src/desktop/commands.ts), [`contracts/index.ts`](../../../bundles/features/papercraft/src/contracts/index.ts), [`canvas-source.ts`](../../../bundles/features/papercraft/src/client/surface/canvas-source.ts)) |
| `papercraft` | `doric.windows/v1`, its `capture` method only    | A PNG of a rectangle of the calling window, for `papercraft.snapshot/v1` ([`papercraft/src/desktop/snapshot.ts`](../../../bundles/features/papercraft/src/desktop/snapshot.ts))                                                                                                                                                                                                                                                                                                                                                      |
| `screen`     | `doric.windows/v1` (`open`, `focus`, `navigate`) | One view window per screen view, key `screen:<viewId>`, partition `screen:<viewId>`, the view's label as title and a native title bar ([`screen/src/desktop/index.ts`](../../../bundles/features/screen/src/desktop/index.ts), [`screen/src/desktop/windows.ts`](../../../bundles/features/screen/src/desktop/windows.ts))                                                                                                                                                                                                           |

A bundle calls a `doric.*` contract with `services.use` and lists no manifest line for it: platform contracts always exist in their environments ([Contracts](contracts.md), [Manifest](manifest.md)). Calling `doric.windows/v1` directly skips what `windows/v1` adds, the key prefix and `core.hooks/v1.onBeforeOpenWindowHook`: the core's own windows and `screen`'s windows use their keys as given.

The core's `desktopMain` part, like every `desktopMain` part, runs in the desktop generation's utility process, and main answers its `doric.windows/v1` calls ([Process isolation](process-isolation.md#desktop-generations), [`process.ts`](../../../app/desktop/doric/src/platform/generation/process.ts)). Each call forwards the `call` it received as its last argument, so the hop to main inherits `scope`, `signal` and `trace` ([Services and channels](services-and-channels.md)).

## The open request

`open` takes one of two strict shapes, so a request names exactly one content ([`basic/windows.ts`](../../../packages/bundle/src/contracts/basic/windows.ts)):

```ts
// An app window: the shell renders doric://app<path>.
type PathWindowRequest = {
  key: string;
  path: string; // must start with '/'
  appearance?: WindowAppearance;
  primary?: boolean;
};

// A view window: a page on the host, in its own session.
type ViewWindowRequest = {
  key: string;
  view: {
    path: string; // host-relative, starts with '/'
    partition: string; // Electron session partition of the view
    title?: string; // absent: the page's own title
  };
  appearance?: WindowAppearance;
  primary?: boolean;
};

type OpenWindowRequest = PathWindowRequest | ViewWindowRequest;

// Visual intent; see Window appearance.
type WindowAppearance = {
  size?: {
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
  };
  titleBar?: 'native' | 'integrated' | 'none'; // default 'integrated'
  background?: string; // a token name, default 'window'
};
```

| Field        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`        | The window's identity. An empty key is `invalid_input`. Opening an open key focuses that window; different keys are different windows. Two windows with the same content use different keys, such as one per canvas or per screen view                                                                                                                                                                                                                                                                                                                   |
| `path`       | The app path the window shows. The data a window needs goes in its path; there is no other input                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `view`       | The host page the window shows. A bundle names a path, never an address: main alone knows the host's origin (`hostUrl`), so a deployment can put the host behind a remote server or a reverse proxy ([`view.ts`](../../../app/desktop/doric/src/platform/windows/view.ts))                                                                                                                                                                                                                                                                               |
| `appearance` | The window's size, title bar and background token, never native options. Absent, the window is 800 × 600; no window is created smaller than 320 × 240 or larger than the primary display's work area. A `background` that names no window color token makes the creation throw `Unknown window color token "<name>".`, and `open` rejects with it ([`tokens.ts`](../../../app/desktop/doric/src/platform/tokens.ts), [`appearance.ts`](../../../app/desktop/doric/src/platform/windows/appearance.ts), [Native window appearance](window-appearance.md)) |
| `primary`    | Marks the primary window ([below](#the-primary-window))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## `doric.windows/v1`

`doric.windows/v1` exists only in `desktopMain`, and the main process is its only provider ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`broker.ts`](../../../app/desktop/doric/src/platform/generation/broker.ts)). Its shape; each method takes a last optional `call?: CallArg`, the parent call or `{ signal?, deadline? }`:

```ts
interface DoricWindows {
  open(request: OpenWindowRequest, call?: CallArg): Promise<void>;
  focusOrOpen(key: string, call?: CallArg): Promise<void>;
  lastPath(key: string, call?: CallArg): Promise<string | null>;
  focus(key: string, call?: CallArg): Promise<boolean>;
  navigate(input: { key: string; path: string }, call?: CallArg): Promise<void>; // path starts with '/'
  capture(input: WindowCaptureRequest, call?: CallArg): Promise<WindowCapture>;
}

interface WindowCaptureRequest {
  key: string; // not empty
  rect: { x: number; y: number; width: number; height: number }; // CSS px of the viewport
}

interface WindowCapture {
  png: string; // the PNG bytes, base64
  width: number; // device pixels
  height: number; // device pixels
  scale: number; // device pixels per CSS px
}

const WINDOW_CAPTURE_MAX_SIDE = 4096; // CSS px
```

The inputs are checked against the contract's schemas before main runs a method: `navigate`'s `path` must start with `/`; a capture's `x` and `y` are not negative, and its `width` and `height` are positive and at most `WINDOW_CAPTURE_MAX_SIDE` ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)). What each method does ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`view.ts`](../../../app/desktop/doric/src/platform/windows/view.ts)):

- **`open`** refuses an empty key with `invalid_input`, applies the [primary rule](#the-primary-window), and refuses an app request whose path does not start with `/` with `invalid_input`, whether or not the key is open. Then:
  - When the key is open, it restores the window if minimized and focuses it. An open app window asked for another path loads `doric://app<path>`; an open view window asked for another host path loads it. A request whose content kind differs from the open window's only focuses it. The appearance of an open window does not change.
  - Otherwise it creates the window: an app window loads `doric://app<path>`; a view window loads `new URL(view.path, hostUrl)`.
  - It resolves once the load has finished. A load that fails rejects with `unavailable` (`The window could not load: …`). A path with no route is not an error: the window opens and its outlet shows `<core-not-found>`.
- **`focusOrOpen(key)`** focuses the open window of `key`, restoring it if minimized. When none is open, it reopens the key with the last request opened under it in this run: an app window at the key's last path, or the request's path when there is none; a view window at the host path main last loaded in it through `open` or `navigate`. A key never opened in this run is `not_found`.
- **`lastPath(key)`** answers the last app path main stored for the key, kept across runs, or `null`; a view window's key answers `null`.
- **`focus(key)`** focuses the open window of `key` without navigating it, restoring it if minimized, and answers `true`; it answers `false` when no such window is open.
- **`navigate({ key, path })`** loads another host path in an open **view** window, resolved against `hostUrl`, and remembers it for `focusOrOpen`. It refuses an app window with `invalid_input` (`… is an app window; it cannot be navigated to a host path.`) and a key that is not open with `not_found`; a load that fails is `unavailable`. An open app window takes a new path only through `open`.
- **`capture({ key, rect })`** takes a PNG of `rect` of an open **app** window. The rectangle is scaled by the page's zoom into the window's units, outward to whole units, and captured from the window's contents with `webContents.capturePage`, which includes out-of-process frames such as a preview frame, at the display's pixel ratio. A key that is not open is `not_found`; a view window, or a rectangle outside the window's content area, is `invalid_input`; a capture that fails or comes back empty is `unavailable`. Errors carry `windowKey` in their details.

## `windows/v1`: windows other bundles ask for

`windows/v1` is a basic contract of the `desktopMain` environment with cardinality `one`; its reference `WindowsV1` and its type are exported by `bundle/contracts`, and its one method is exposed to desktop windows, so a client part that lists it under `requires` reaches it through the bridge ([`basic/windows.ts`](../../../packages/bundle/src/contracts/basic/windows.ts), [`basic/index.ts`](../../../packages/bundle/src/contracts/basic/index.ts), [Contexts](contexts.md)):

```ts
interface Windows {
  open(request: OpenWindowRequest, call?: CallArg): Promise<void>;
}
```

The core provides it by default, at version 1.1.0, as `coreWindows` ([`core/src/desktop/windows.ts`](../../../bundles/foundation/core/src/desktop/windows.ts)). Its `open`:

1. refuses an empty key with `invalid_input`;
2. runs `core.hooks/v1.onBeforeOpenWindowHook`, a `transform` hook whose input is the request, so other bundles can adjust it ([Hooks](hooks.md));
3. opens the adjusted request through `doric.windows/v1.open` under the key `<call.caller.bundleId>:<key>`, built from the key of the original request, so a handler cannot change it.

The prefix keeps two bundles from sharing a key. A bundle that needs a window lists `windows/v1` under `requires`, as `papercraft` does with `windows/v1@^1.0.0` ([`papercraft/manifest.json`](../../../bundles/features/papercraft/manifest.json)). The composition may choose another provider of `windows/v1` under `providers`; the core then uses the chosen one ([The core bundle](core.md#replacing-a-contract-the-core-provides)). The full contract of the core's provider is in the [README of `core`](../../../bundles/foundation/core/README.md#windowsv1).

## The windows of the shipped bundles

| Key                                  | Kind | Content                                                          | Opened by                            |
| ------------------------------------ | ---- | ---------------------------------------------------------------- | ------------------------------------ |
| `workspace`                          | App  | `/` and its child routes, drawn by [`layout`](layout.md)'s frame | `core`, when the app is ready        |
| `settings`                           | App  | `/settings` and its sections, drawn by `settings`'s page         | `core.open-settings/v1`              |
| `papercraft:program:<threadId>/<id>` | App  | A Papercraft canvas                                              | `papercraft`, through `windows/v1`   |
| `screen:<viewId>`                    | View | A screen view's page on the host                                 | `screen`, through `doric.windows/v1` |

The workspace window opens at 1280 × 800, at least 960 × 640, and the settings window at 960 × 720, at least 720 × 520, both with the integrated title bar ([`core/src/desktop/appearance.ts`](../../../bundles/foundation/core/src/desktop/appearance.ts)). How the elements of each app window are composed is in [UI composition](ui-composition.md); the workspace window's frame and slots are in [The layout bundle](layout.md).

## The settings window: `core.open-settings/v1`

`core.open-settings/v1` (version 1.1.0) is a command of the core's `desktopMain` part, registered in `commands/v1`. Its input is `{ path?: string; defaultPath?: string }`, strict ([`core/src/contracts/commands.ts`](../../../bundles/foundation/core/src/contracts/commands.ts), [`core/src/desktop/commands.ts`](../../../bundles/foundation/core/src/desktop/commands.ts)):

- with `path`, the settings window opens at `path` through `doric.windows/v1.open`, key `settings`, which focuses an open settings window and loads `path` when it shows another one;
- without `path`, an open settings window is only focused and keeps its section, and `defaultPath` is ignored;
- without `path` and with no settings window open, a new one opens at `defaultPath`;
- with neither, and no settings window open, the command fails with `invalid_input` and nothing opens.

The core knows no settings route of its own. The `settings` bundle registers `/settings` and dispatches the command, with `{ defaultPath: '/settings' }`, from its "Settings" item in the account menu and its "All settings" item in the Dashboard's footer ([`settings/src/client/index.ts`](../../../bundles/desktop/settings/src/client/index.ts)). Another bundle dispatches it by id, or with the typed reference `OpenSettingsCommandV1` from `core/contracts` through `services.use(CommandsV1).execute(OpenSettingsCommandV1, input)`. The command's full contract is in the [README of `core`](../../../bundles/foundation/core/README.md#coreopen-settingsv1).

## The primary window

A request may set `primary: true`. The mark is fixed when the window is created ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)):

- a `primary` request for a key that is open without the mark is refused with `registration_conflict`;
- a `primary` request while another open window is primary is refused with `registration_conflict`, so at most one open window is primary;
- a request without the mark never demotes an open primary window.

In the primary window, a quarantined core is a core failure: the window reports it to main instead of `ready`, and main shows the recovery surface ([`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts), [Splash and recovery](splash-and-recovery.md)). The core marks `workspace` primary.

### Start, activation and quit

- **Start.** In `onAppReadyHook` the core sets the menu skeleton, calls `doric.migrations/v1.storage({ key: 'doric.selection', marker: 'selectionOrigin' })` to copy the saved selection once, logging a failure as the warning `Selection migration did not run` without keeping the window closed, then opens `workspace` as the primary window at `doric.windows/v1.lastPath('workspace')`, or `/` when there is none ([`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts), [`core/src/desktop/migrations.ts`](../../../bundles/foundation/core/src/desktop/migrations.ts), [Hooks](hooks.md#doricapphooksv1)).
- **Activation.** In `onAppActivateHook`, as when the dock icon is clicked, the core calls `doric.windows/v1.focusOrOpen('workspace')`.
- **Last paths.** Main records the pathname of every main-frame navigation of an app window, in-page navigations included, as its key's last path. It writes them to `userData/doric/windows.json` as `{ "lastPaths": { "<key>": "<path>" } }`, atomically, 250 ms after the last change, and at once when a window closes or the app quits. Bounds are neither stored nor restored, and a view window's path is not stored ([`state.ts`](../../../app/desktop/doric/src/platform/state.ts), [`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).
- **Quit.** When `onBeforeQuitHook` allows the quit, main writes `windows.json` and then waits for the pending writes of `userData/doric/state.json` before it exits. The two are one step: when the `windows.json` write fails, `state.json` is not awaited; the failure is logged as `Desktop state could not be saved before quit` and the quit goes on. A second quit request while `onBeforeQuitHook` decides, or while the writes are pending, quits at once without waiting for them ([`lifecycle.ts`](../../../app/desktop/doric/src/platform/lifecycle.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`paths.ts`](../../../app/desktop/doric/src/platform/paths.ts)).

## What an app window loads

Every app window is a `BrowserWindow` that loads the same shell page and bootstrap: the [`doric://` protocol](doric-protocol.md) answers a navigation to any path outside its asset prefixes with the shell, so a reload keeps the route. The window is created hidden and shown on `ready-to-show` ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)). Main binds the key to the window's `webContents`, which is how its dispatcher knows which window a request comes from ([`registry.ts`](../../../app/desktop/doric/src/platform/windows/registry.ts)).

The shell's script runs `bootstrapWindow` from `packages/desktop` ([`doric-renderer/src/bootstrap.ts`](../../../app/desktop/doric-renderer/src/bootstrap.ts), [`bootstrap.ts`](../../../packages/desktop/src/client/bootstrap.ts)):

1. It reads the window's description through the preload's `describeWindow()` and applies its chrome, the title bar height and the safe area, as CSS variables; main pushes a new chrome when the window enters or leaves full screen. The description is `{ key, kind: 'window', primary, path, generation, chrome, mode, tokens, app: { version } }` ([`protocol.ts`](../../../packages/desktop/src/client/protocol.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [Native window appearance](window-appearance.md)).
2. It reads the window's catalog and activates the client parts: the foundation, then the core, then the others. Once the provider of `hooks/v1` has activated, the platform defines `doric.app.hooks/v1` and `doric.window.hooks/v1` in it ([`activate.ts`](../../../packages/desktop/src/client/activate.ts), [The core bundle](core.md#activation-order-foundation-core-others), [Hooks](hooks.md#when-the-platform-defines-them)).
3. It wires the [close protocol](#closing-a-window), the keybindings and the commands main sends to the window.
4. It replaces the `body`'s children with `<{core}-outlet>`, where `{core}` is the composition's core bundle, so `<core-outlet>` in the shipped composition. The outlet shows the route that matches `location.pathname` ([Navigation](navigation.md#the-outlet-core-outlet)).
5. It calls `ready()`. An exception during these steps is reported as a `bootstrap` failure; a core that did not define its outlet, or a quarantined core in the primary window, is reported as a `core` failure, and the window does not call `ready()` ([Splash and recovery](splash-and-recovery.md)).

The steps and each element they create are in [UI composition](ui-composition.md); the options of `bootstrapWindow` are in the [README of `packages/desktop`](../../../packages/desktop/README.md).

## Closing a window

An app window answers each close through `doric.window.hooks/v1` ([`windows/close.ts`](../../../app/desktop/doric/src/platform/windows/close.ts), [`client/close.ts`](../../../packages/desktop/src/client/close.ts)):

1. Main holds the close and asks the window for the **close** phase. Unless the close is forced, the window runs `onCloseHook`, a `decide` hook without a deadline. A refusal keeps the window open, and main logs `Window close denied` with its reason.
2. Once allowed, main asks for the **flush** phase with a deadline 1,500 ms ahead (`WINDOW_FLUSH_DEADLINE_MS`). The window runs `onFlushHook`, an `observe` hook, within that deadline and answers whatever its handlers do.
3. Main closes the window when the window answers the flush or the 1,500 ms pass, whichever comes first.

A close is forced while the app quits, and a second close while the first waits for the veto forces it too. A window that never answers the close phase stays open until it is closed again. When a window closes, main drops its key and writes the last paths. A view window has no close protocol and closes at once. The hooks and how a bundle registers on them are in [Hooks](hooks.md#doricwindowhooksv1).

## Isolation of a window

**An app window.** Its `webContents` runs sandboxed, with context isolation, without Node integration, and with the app's preload ([`appearance.ts`](../../../app/desktop/doric/src/platform/windows/appearance.ts)). Main installs a navigation guard on it ([`navigation-guard.ts`](../../../app/desktop/doric/src/platform/windows/navigation-guard.ts)):

- the main frame may not navigate to any URL other than the one it shows (`will-navigate`); main's own loads are not renderer-initiated and pass;
- every subframe stays at the preview frame document, `doric://app/frame/index.html` with any query, whoever starts the navigation (`will-frame-navigate`);
- the window may not open windows of its own: every `window.open` is denied.

The packaged shell's policy allows scripts only from `'self'` and the hash of the shell's inline import map, workers only from `'self'`, and frames only under `doric://app/frame/`. The development shell's policy allows scripts from `'self'`, with `'unsafe-eval'`, and the same hash, and frames only under `doric://app/frame/`. The splash's policy has no `frame-src` and falls back to `default-src 'none'`. So no window frames a foreign origin, the only frame a shell embeds is the preview frame, and the splash frames nothing ([`csp.ts`](../../../app/desktop/doric/src/platform/protocol/csp.ts), [The `doric://app` protocol](doric-protocol.md#content-security-policies)). Main's dispatcher refuses every request that does not come from the main frame of a registered window or of the splash, or whose frame URL is not a `doric://app` URL, with `The request source is not allowed.`; the preload does not run in subframes, since a window's preferences do not enable it there ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`sender.ts`](../../../app/desktop/doric/src/platform/bridge/sender.ts), [`appearance.ts`](../../../app/desktop/doric/src/platform/windows/appearance.ts)).

A preview frame is an `<iframe sandbox="allow-scripts">` with an opaque origin. In Electron 44.4.3, the version the app ships ([`package.json`](../../../package.json)), Chromium runs sandboxed iframes in a renderer process of their own by default (`IsolateSandboxedIframes`); the app sets no switch for it, and the end-to-end test asserts that the preview frame's process differs from the shell's ([`preview-frame.test.ts`](../../../app/desktop/doric-e2e/tests/preview-frame.test.ts)). The frame's realm and origin isolation do not depend on it.

**A view window.** It is a `BaseWindow` whose whole content is one `WebContentsView`, resized with the window. The view runs sandboxed, with context isolation, without Node integration, with no preload and no bundle contracts, in the session partition the request names, which keeps the page's cookies, storage and cache apart from the app's. It may navigate within the origin of its host path only, and may not open windows. With a `title` the window shows it; without one it follows the page's title. The window is shown at once, and closing it closes the view's contents ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`navigation-guard.ts`](../../../app/desktop/doric/src/platform/windows/navigation-guard.ts), [`view.ts`](../../../app/desktop/doric/src/platform/windows/view.ts)). It does not use the `doric://` protocol, and its page gets none of the app's policies ([The `doric://app` protocol](doric-protocol.md#windows-and-senders)).

## `doric.browser/v1`: the system browser

A window may not open windows; `doric.browser/v1` is its one way out of the app. It exists only in the `client` environment ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts)):

```ts
interface DoricBrowser {
  open(url: string, call?: CallArg): Promise<void>;
}
```

`url` must be an absolute `https:` URL of at most 8,192 characters; anything else is `invalid_input`, and a URL that is not `https:` fails with the message `Expected an https URL.`. The window's platform forwards it to main as the platform-internal call `doric.shell/v1.openExternal`; main checks the URL again against the same schema and hands it to Electron's `shell.openExternal`, logging only its origin, since the query may carry a sign-in's state ([`browser.ts`](../../../packages/desktop/src/client/browser.ts), [`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). `settings`, `mcp` and `claude-login` use it to open a provider's or a server's authorization page ([`settings-api.ts`](../../../bundles/desktop/settings/src/client/api/settings-api.ts), [`mcp/src/client/api.ts`](../../../bundles/features/mcp/src/client/api.ts), [`claude-login/src/client/api.ts`](../../../bundles/features/claude-login/src/client/api.ts)).

The other platform contracts that exist only in `client`, `doric.elements/v1`, `doric.connection/v1`, `doric.about/v1` and `doric.appearance/v1`, and those a window shares with other environments, are in [Contexts](contexts.md#shapes-of-the-platform-contracts).

## Related documents

- [The core bundle](core.md): the core's desktop part, which opens `workspace` and `settings` and provides `windows/v1`.
- [Navigation](navigation.md): the route a window's path selects and the outlet that shows it.
- [UI composition](ui-composition.md): how the elements of each window are composed.
- [The layout bundle](layout.md): the frame of the workspace window at `/`.
- [Native window appearance](window-appearance.md): the `appearance` intent and the window's chrome.
- [Hooks](hooks.md): `doric.app.hooks/v1`, `doric.window.hooks/v1` and the hook kinds.
- [The `doric://app` protocol](doric-protocol.md): the shell, the content security policies and the preview frame.
- [Splash and recovery](splash-and-recovery.md): what a core failure in the primary window leads to.
- [Process isolation](process-isolation.md): the desktop generation process whose calls main answers.
- [Services and channels](services-and-channels.md): `call`, `caller` and the bridge from a window.
- [Contexts](contexts.md): the platform contracts of each environment.
- [Menus and keybindings](menus-and-keybindings.md): the menu skeleton the core sets beside the first window.
- [Boundaries](boundaries.md): what a bundle may import and call.
