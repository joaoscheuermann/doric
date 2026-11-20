# The `doric://app` protocol

- Status: living document. It describes the `doric` scheme, the files it serves and the content security policies it sets as implemented on 2026-11-20.

## Summary

Every app window of the desktop loads from one origin, `doric://app`, served by a privileged custom scheme, `doric`, that the main process registers and handles itself. The shell, the platform packages, the bundle artifacts in the local cache, the published JSON Schemas, the preview frame document and the verified papercraft modules all come from that origin, so `'self'` in the shell's content security policy covers all of them. The handler answers a navigation to any app path with the shell, a file under a served prefix with that file, and anything else with `404`. A view window is the exception: it loads a page of the host's own origin and carries no preload ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [`scheme.ts`](../../../app/desktop/doric/src/platform/protocol/scheme.ts), [`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts)).

## The scheme

The scheme is registered before the app is ready, as `standard`, `secure`, `supportFetchAPI`, `corsEnabled` and `codeCache`; `main.ts` imports the registration for its side effect as its first import ([`privileges.ts`](../../../app/desktop/doric/src/platform/protocol/privileges.ts), [`main.ts`](../../../app/desktop/doric/src/main.ts)). Once the app is ready, the platform installs the handler with `protocol.handle('doric', …)` on the default session ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

A URL belongs to the origin when its protocol is `doric:` and its host is `app`. The code compares the two parts, not `URL.origin`, which Node reports as `'null'` for a scheme it does not know ([`scheme.ts`](../../../app/desktop/doric/src/platform/protocol/scheme.ts)).

## What the handler serves

The handler picks a route from the URL alone; the query and the hash are ignored. For the shell route it also reads the request headers ([below](#the-shell-answers-only-a-navigation)). A host other than `app` is a `404`. `userData` below is Electron's per-user data directory, `app.getPath('userData')` ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [`main.ts`](../../../app/desktop/doric/src/main.ts)).

| Path                                    | What it serves                                                                               | Read from                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/frame/index.html`                     | The preview frame document, with its own policy                                              | Rendered in memory                                                 |
| `/frame/boot.js`                        | The preview frame's boot script                                                              | A constant of the app                                              |
| `/papercraft-modules/<dir>/<file…>`     | A verified papercraft module file; `<dir>` is 64 lowercase hex characters                    | `userData/papercraft/<dir>/`                                       |
| `/platform/shell@<v>/<file…>`           | The shell's own assets (the renderer build)                                                  | `doric-renderer/` beside the built main process, or the dev server |
| `/platform/splash@<v>/index.html`       | The splash page, with the splash policy                                                      | `assets/platform/`                                                 |
| `/platform/<package>@<version>/<file…>` | A platform package or any other platform file, such as `splash@<v>/blank.html`               | `assets/platform/`                                                 |
| `/bundles/<id>@<version>/<file…>`       | A file of a bundle artifact, only when a retained generation lists that file for that bundle | The local bundle cache                                             |
| `/schemas/<file…>`                      | A JSON Schema the platform publishes                                                         | `assets/schemas/`                                                  |
| Any other path                          | The shell, for a navigation only                                                             | Rendered per request                                               |

`<v>` is `PLATFORM_ASSETS_VERSION` ([`version.ts`](../../../packages/bundle/src/runtime/version.ts)); `assets/` sits beside the built main process ([`resources.ts`](../../../app/desktop/doric/src/platform/protocol/resources.ts)). A generation is retained from the moment the desktop starts it until it fails to activate, or until a newer generation is the newest and no open window uses it; while it is retained, the cache keeps the list of files of each of its bundles ([`app.ts`](../../../app/desktop/doric/src/platform/app.ts); generations and their artifacts are described in [composition and distribution](./composition-and-distribution.md)). The cache answers `/bundles/` only for a path that the file list of a retained generation names for `<id>@<version>`, so an unlisted file in the cache directory is a `404` ([`artifacts.ts`](../../../app/desktop/doric/src/platform/catalog/artifacts.ts)). The `papercraft` bundle's `desktopMain` part writes the module directories when a window calls its contract `papercraft.cache/v1` (`ensure`): it writes each file into its `doric.cache/v1` directory ([contexts](./contexts.md)), which for that bundle is `userData/papercraft/`, only after the file's SHA-256 matches the expected one, and stages each write and renames it into place so no partial file is served ([`cache.ts`](../../../bundles/features/papercraft/src/desktop/cache.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts), [`paths.ts`](../../../app/desktop/doric/src/platform/paths.ts); see the [`papercraft` README](../../../bundles/features/papercraft/README.md)). The platform files and the schemas are written by the `doric-platform` build: `importmap.platform.json` and the packages under `assets/platform/`, and under `assets/schemas/` the documents of the bundle manifest, the composition and the contracts descriptor, each with an `$id` under `doric://app/schemas/` ([`project.json`](../../../app/desktop/doric-platform/project.json), [`platform-schemas.ts`](../../../packages/bundle/src/build/platform-schemas.ts)).

### Path safety

Each segment under a prefix is URL-decoded. A segment that is empty, `.`, `..`, fails to decode, or holds NUL, `/` or `\` once decoded makes the request a `404`, and so does an empty path under a prefix, a `/bundles/` folder without an `@` that splits a non-empty id from a non-empty version, a bundle path with no file after the folder, a `/papercraft-modules/` directory that is not 64 lowercase hex characters, a `/papercraft-modules/<dir>/` path with no file, `/platform/shell@<v>/` with no file, and a `/frame/` path other than the two files. The resolved path must also stay inside its root; a path that resolves to the root itself or outside it is a `404` ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)).

### Responses

A served file is answered with status `200` and a `content-type` chosen by its extension, matched without regard to case (`.js` and `.mjs` as `text/javascript`, `.css`, `.json`, `.map`, `.html`, the fonts `.woff2`, `.woff`, `.ttf` and `.otf`, the images `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif` and `.ico`, `.wasm` and `.txt`; any other extension is `application/octet-stream`) ([`mime.ts`](../../../app/desktop/doric/src/platform/protocol/mime.ts)). A failure to serve a file (a route that serves nothing, a path that leaves its root, a file that cannot be read or a URL that does not parse) is `404` with the body `Not found` as `text/plain`; it is never the shell ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)). A failure to render the shell is not turned into a `404`: when the template cannot be read or fetched, the dev server answers a status that is not ok, or the template has no `<head>`, the handler's promise rejects and the navigation fails ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts), [`shell.ts`](../../../app/desktop/doric/src/platform/protocol/shell.ts), [`dev-proxy.ts`](../../../app/desktop/doric/src/platform/protocol/dev-proxy.ts)).

### The shell answers only a navigation

The shell is an HTML document, so it answers only a request that navigates a document. Electron passes a custom scheme's handler no `Sec-Fetch-Dest`, so the handler decides from the headers it has: a `Sec-Fetch-Dest`, when present, must be `document`; otherwise an `Accept` that names `text/html` or `application/xhtml+xml` is a navigation, and a request with neither header is taken as one. A request at an app path that does not accept HTML (a font, an image, a script, a fetch) is a `404`, so it is never answered with HTML read as the file it asked for. A path whose last segment carries an extension, such as `/secret.txt`, names a file and is a `404` as well ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)).

Any other path is a route of the app, such as `/` or `/projects/p1/threads/t1`, and receives the same shell, so reloading a window keeps its route; the core's router decides on the client what the path shows ([navigation](./navigation.md)).

## The shell document

The shell is rendered for each request from the renderer build's `shell.html`. The renderer inserts, as the first children of `<head>` ([`shell.ts`](../../../app/desktop/doric/src/platform/protocol/shell.ts)):

1. `<meta name="doric-generation" content="<n>">`, the newest client generation, when there is one;
2. `<script type="importmap">` with the import map of that generation, with `<` escaped as `\u003c`;
3. `<link rel="stylesheet" href="/platform/desktop@<v>/theme.css">`.

The template is read once from the shell root and cached when packaged (a failed read is retried on the next request), and fetched from the dev server on every request in development. The import map is the platform map read from `importmap.platform.json` plus, for each retained bundle of the generation that ships a `contracts/` part, `"<id>/contracts"` mapped to `doric://app/bundles/<id>@<version>/<entry>`; without a generation it is the platform map alone. The map is computed once per generation ([`shell.ts`](../../../app/desktop/doric/src/platform/protocol/shell.ts), [`import-map.ts`](../../../app/desktop/doric/src/platform/protocol/import-map.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)). The shell knows no route and no title. The platform packages of the map are described in [platform packages](./platform-packages.md), and the bundle artifacts reach the cache through [composition and distribution](./composition-and-distribution.md).

## Content security policies

The protocol sets each policy as a `content-security-policy` response header, on the shell, the splash page and the frame document only; no other response carries one, and bundles add no directive ([`csp.ts`](../../../app/desktop/doric/src/platform/protocol/csp.ts), [`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)). `<hash>` is the base64 SHA-256 of the exact text of the document's inline import map ([`shell.ts`](../../../app/desktop/doric/src/platform/protocol/shell.ts)).

The packaged shell:

```text
default-src 'none'; script-src 'self' 'sha256-<hash>'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src doric://app/frame/; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Fonts load only from `'self'`, the `doric://app` origin. The only document a shell may frame is under `doric://app/frame/`.

The splash page, in both modes, is the packaged policy without the hash and without `frame-src`:

```text
default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

The development shell, where `<ws-origin>` is the dev server's origin whose leading `http` becomes `ws` (`https` becomes `wss`):

```text
default-src 'self'; script-src 'self' 'unsafe-eval' 'sha256-<hash>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src doric://app/frame/; connect-src 'self' <ws-origin>; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

The preview frame document, in both modes. A preview frame runs with an opaque origin, where `'self'` matches nothing, so every source names `doric://app`, fonts included:

```text
default-src 'none'; script-src doric://app 'sha256-<hash>'; style-src doric://app 'unsafe-inline'; font-src doric://app; img-src doric://app data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors doric://app
```

## The preview frame

A preview loads `doric://app/frame/index.html` in an `<iframe sandbox="allow-scripts">`. The document holds an import map with only the specifiers `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`, `@base-ui/react` and every `@base-ui/react/…` subpath, each only when the platform map has it and points it under `doric://app/platform/`, and a module script `doric://app/frame/boot.js`. The boot script reads `?entry=` from its URL and imports it only when it matches `doric://app/bundles/<id>@<semver>/client/frames/<name>.js`, with a bundle id and a version as a manifest states them and a name of letters, digits, `_` and `-`; otherwise it does nothing ([`frame.ts`](../../../app/desktop/doric/src/platform/protocol/frame.ts)). An app window lets a subframe navigate only to the frame document, with any query, whoever starts the navigation ([`navigation-guard.ts`](../../../app/desktop/doric/src/platform/windows/navigation-guard.ts)). What a preview shows is described in the [papercraft feature](../../features/papercraft.md).

### Cross-origin access

Because the frame's origin is opaque, every module, font and sheet it loads is a cross-origin CORS request. Only what a frame loads answers `Access-Control-Allow-Origin: *`: `/frame/*`, `/platform/*` except the shell's own assets under `/platform/shell@<v>/` and the splash page `/platform/splash@<v>/index.html`, `/papercraft-modules/*`, and `/bundles/<id>@<version>/client/frames/<file…>`. The rest of `/bundles/`, `/schemas/`, the shell's assets, the splash page and the shell itself are same-origin only ([`handler.ts`](../../../app/desktop/doric/src/platform/protocol/handler.ts)).

## Windows and senders

Every app window and the splash load a `doric://app` URL: a window loads `doric://app/<path>`, the splash loads its page under `/platform/splash@<v>/` ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`window.ts`](../../../app/desktop/doric/src/platform/splash/window.ts)). How a window opens and boots from the shell is in [windows](./windows.md).

The main process answers the single IPC channel `doric:desktop` only from the main frame of a registered window or of the splash, whose frame URL is a `doric://app` URL of any path; a request from any other sender, from a subframe, or from a `file:` or `http:` URL is refused with `The request source is not allowed.` ([`dispatcher.ts`](../../../app/desktop/doric/src/platform/bridge/dispatcher.ts), [`sender.ts`](../../../app/desktop/doric/src/platform/bridge/sender.ts)). The bridges that run over this channel are in [services and channels](./services-and-channels.md).

A view window does not use the protocol. Its whole content is one `WebContentsView` that loads the view's path resolved against the host's URL, in the session partition the view names, sandboxed, with no preload and no bundle contracts. It may navigate within that origin only and may not open windows, and no sender check applies to it, since it cannot reach the IPC ([`native-windows.ts`](../../../app/desktop/doric/src/platform/windows/native-windows.ts), [`view.ts`](../../../app/desktop/doric/src/platform/windows/view.ts), [`navigation-guard.ts`](../../../app/desktop/doric/src/platform/windows/navigation-guard.ts)).

## Development

When the app is not packaged, windows open through `doric://app` as well. Whether the app is packaged comes from Electron's `app.isPackaged`. The handler takes the shell template from `<dev-server>/platform/shell@<v>/shell.html` and forwards every request for a file under `/platform/shell@<v>/` to `<dev-server><path>`, copying the status and the `content-type`; a forward that fails is a `404`, and the bare `/platform/shell@<v>/` folder is a `404` without asking the dev server. The dev server is `http://localhost:4200`, and the environment variable `DORIC_RENDERER_DEV_URL` overrides it. The shell carries the development policy above ([`dev-proxy.ts`](../../../app/desktop/doric/src/platform/protocol/dev-proxy.ts), [`main.ts`](../../../app/desktop/doric/src/main.ts), [`app.ts`](../../../app/desktop/doric/src/platform/app.ts)).

## Copying storage from the `file://` origin: `doric.migrations/v1`

The packaged app can copy a `localStorage` key once from the `file://` origin, which no app window loads, into `doric://app`, where the windows read it. The platform contract `doric.migrations/v1` exposes this to the `desktopMain` environment; the caller names only the key and a marker, and the origins and the pages belong to the platform. `call` is the caller's call context, a `Call` or call options, described in [contracts](./contracts.md#the-call) ([`platform.ts`](../../../packages/bundle/src/contracts/platform.ts), [`call.ts`](../../../packages/bundle/src/contracts/call.ts)).

```ts
interface DoricMigrations {
  storage(request: MigrationRequest, call?: CallArg): Promise<MigrationResult>;
}

interface MigrationRequest {
  /** The localStorage key to copy: /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/ */
  readonly key: string;
  /** The name of the desktop state record that marks the copy done: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/ */
  readonly marker: string;
}

type MigrationResult = 'migrated' | 'none' | 'skipped' | 'failed';
```

The request schema is strict: no other field is accepted. `storage` runs as follows ([`storage-origin.ts`](../../../app/desktop/doric/src/platform/migration/storage-origin.ts), [`state.ts`](../../../app/desktop/doric/src/platform/state.ts)):

1. When the desktop state's `migrations[marker]` is `true`, it returns `skipped`.
2. When the app is not packaged, it records the marker and returns `skipped`; a development profile copies nothing.
3. It loads `assets/legacy-origin.html`, an empty page of the `file://` origin, in a hidden sandboxed window and reads the key. When the key holds no string, it records the marker and returns `none`.
4. It loads `doric://app/platform/splash@<v>/blank.html` in a second hidden window and writes the value only when the key is not set there, records the marker and returns `migrated`.
5. Any failure is logged as `Storage origin migration failed` with the marker, and the result is `failed`. When loading a page, reading or writing the key fails, the platform records the marker anyway; when recording the marker itself fails, the marker stays unrecorded. `storage` does not reject, and both hidden windows are destroyed.

The `core` bundle's `desktopMain` part calls it in `onAppReadyHook`, after it sets the menu skeleton and before it opens the primary window, and awaits the answer, with the key `doric.selection` and the marker `selectionOrigin`; a call that fails is logged and the window opens anyway ([`migrations.ts`](../../../bundles/foundation/core/src/desktop/migrations.ts), [`core/src/desktop/index.ts`](../../../bundles/foundation/core/src/desktop/index.ts); see the [`core` README](../../../bundles/foundation/core/README.md)). `doric.selection` is the selection the `workspace` bundle reads, at `/` only, to restore the selected Thread, and removes once the restore settles, or, after a failed lookup, once a later selection is written ([`route-selection.ts`](../../../bundles/desktop/workspace/src/client/stores/route-selection.ts); see the [`workspace` README](../../../bundles/desktop/workspace/README.md)).

## Related documents

- [Windows](./windows.md): every window loads the shell at `doric://app/<path>` and boots from it.
- [Navigation](./navigation.md): the core's router changes `location.pathname`, and the handler answers the shell for any route.
- [Platform packages](./platform-packages.md): the packages served under `/platform/` and the import map whose hash is in the policy.
- [Composition and distribution](./composition-and-distribution.md): how verified artifacts reach the cache served under `/bundles/`.
- [Contracts](./contracts.md): the schemas published under `/schemas/` and the `doric.*` platform contracts.
- [Services and channels](./services-and-channels.md): the bridges that run over the `doric:desktop` channel.
- [Splash and recovery](./splash-and-recovery.md): the splash page served under `/platform/splash@<v>/`.
- [Boundaries](./boundaries.md): what a client part may import.
