> Record (2026-11-20). This document is kept as a record and does not describe current behavior; the living description is [docs/features/papercraft.md](../../../features/papercraft.md).

# Papercraft: the preview in an isolated iframe

**Status:** approved by the user on 2026-10-27 and implemented; the frame's decisions (opaque origin, CSP, CORS by path prefix, a cap of 3 live frames per window, in-memory storage) still hold after the switch to OpenUI ([docs/features/papercraft.md](../../../features/papercraft.md)). Since 2026-11-06 the frame loads `client/frames/openui.js`, which draws an OpenUI Lang program, and imports the verified modules from `doric://app/papercraft-modules/<dir>/<file>` instead of `/artifacts/*`. It replaces the decision "No iframe" of the first version of the [papercraft design](README.md#resumo).

## Why

Before this design, a revision's module (`doric://app/artifacts/<id>@<rev>/index.js`) was imported into the app's realm and mounted in a shadow root (`src/client/surface/preview-surface.tsx`). The shadow root isolates the DOM and the CSS, not the JavaScript: all previews shared the `window`, the custom elements registry, the globals and the app's error channel — and reached `window.doric.desktop`, the preload's bridge. The visible symptom was React #520 from old revisions that competed for the same custom element tag; the underlying reason was that the Project's code ran with the app's powers.

## Decision

Each preview runs in an `<iframe sandbox="allow-scripts">` without `allow-same-origin`: an opaque origin (`null`), its own realm, no preload, no persistent storage of the app and no access to the app's DOM. The app and the frame talk only through a `MessageChannel`.

What ceases to exist: the portal container passed in `context.papercraft.portalContainer` (the frame's `document.body` belongs to the preview), the rewriting of `:root` into `:host` in the preview's CSS, the shadow root's reset, the `.dark` wrapper around the root and the portal, and the competition for globals and tags between revisions.

The user's decisions (2026-10-27):

1. In-memory storage: the frame runtime installs in-memory `localStorage` and `sessionStorage`, because in an opaque origin they throw an error. Nothing persists.
2. At most **3 live frames**: the 3 used last (published, visible or with pointer/click). The others show a snapshot; see [Virtualization](#virtualization).
3. No scoping of artifacts by capability: CORS stays restricted by prefix.
4. The frame runtime is an asset of the `papercraft` bundle, not a platform package.
5. The cost of each frame evaluating its own React is left to optimize later.

## Contracts between the parts

These contracts are what the phases implement in parallel; changing them requires agreement between the parts.

### The frame document (platform)

- `doric://app/frame/index.html?entry=<URL do runtime>`: a minimal document served by the main process, with its own `<script type="importmap">` and an empty `<body>`.
- The frame's import map has only a preview's externals: `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client` and the `@base-ui/react/*` specifiers of the platform's map, as absolute URLs `doric://app/platform/…`.
- `doric://app/frame/boot.js` reads `entry`, accepts only `doric://app/bundles/<id>@<versão>/client/frames/<nome>.js` and imports that module.
- The frame's CSP, in a header: `default-src 'none'; script-src doric://app 'sha256-<import map>'; style-src doric://app 'unsafe-inline'; font-src doric://app; img-src doric://app data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors doric://app`. The origin is opaque, so `'self'` does not work.
- The shell's CSP: gains `frame-src doric://app/frame/`.
- `Access-Control-Allow-Origin: *` only on `/frame/*`, `/platform/*`, `/artifacts/*` and `/bundles/<id>@<versão>/client/frames/*`. `/bundles/*` outside `client/frames`, `/schemas/*` and the shell remain without CORS.
- A preview frame only navigates to `doric://app/frame/index.html` (`will-frame-navigate`); the dispatcher already refuses IPC from subframes and the preload does not run in them.
- Process: sandboxed iframes in a renderer process separate from the app's when Electron's Chromium does so (`IsolateSandboxedIframes`); the realm and origin isolation does not depend on it.

### Bundle frames (`packages/bundle`)

- A bundle's `src/client/frames/*.ts` becomes `dist/client/frames/<nome>.js`: an ESM module of its own, with the externals of the frame's import map (not the client's) and nothing of the client bundled in beyond what it imports.

### The preview runtime (`bundles/features/papercraft/src/client/frames/preview.ts`)

- Receives the channel's port in a single window message and from then on speaks only through it.
- Mounts the revision: imports `index.js` and calls `mount(root, { theme })` on a `#root` in the `<body>` (the usual contract, so old revisions mount without change), links `index.css` by `<link>`, or renders path A's markup.
- Theme on the `<html>` (`class="dark"`), switchable live. In-memory storage. React errors and errors of the frame's window become `error` messages.
- Derives the scene graph from its own DOM and sends it serialized, with bounds in the frame's CSS px (the app scales the iframe by `transform`, so the measurements do not depend on zoom).
- Applies the hidden layers and the locked cursor the app asks for; forwards the pointer, wheel and keys the app uses, with the node under the pointer.

### The protocol

`bundles/features/papercraft/src/client/frame-protocol.ts` defines the messages, the version and the schemas the app uses to validate what comes from the frame — everything that comes from the frame is untrusted data.

### The snapshot (`papercraft.snapshot/v1`)

- The papercraft's desktop contract: the window asks for the capture of a rectangle of its own (the window's CSS px) and receives a PNG. The main process captures by `webContents.capturePage`, which works with frames of opaque origin.

## Phases

| Phase             | Delivery                                                                                                                                           | Proof                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–1. Platform     | Frame document, `boot.js`, CSP, CORS by prefix, navigation guard, check of the separate process                                                    | Protocol tests in `doric-app`; proof in Electron (`doric-e2e`): the frame loads, imports the platform's React, mounts an artifact module, does not see `window.doric` and does not navigate |
| 2. Runtime        | `src/client/frames/preview.ts` and the frame support in `packages/bundle`                                                                          | Runtime tests in happy-dom speaking the protocol                                                                                                                                            |
| 3. Surface        | The app over the protocol: iframe in place of the shadow root; scene, gestures, focus, fit and pins over serialized nodes; path A inside the frame | Tests of `surface`, `element`, `scene` and `pins` against a fake runtime                                                                                                                    |
| 4. Build          | Entry without a portal container, CSS without `:host`, harness without the addon-themes stand-in; old revisions keep mounting                      | `module-mount`, `compile`, `harness` and a revision fixture in the old format                                                                                                               |
| 5. Virtualization | Cap of 3 live frames, snapshots and `papercraft.snapshot/v1`                                                                                       | Tests of the policy and of the capture contract                                                                                                                                             |
| 6. Cleanup        | Harnesses without `portalContainer`, skill, READMEs, the documentation and the papercraft design                                                   | `format:check`, `lint`, `git diff --check`                                                                                                                                                  |

## Virtualization

- **Live:** the 3 frames used last; a new preview evicts the least recent. In the canvas window, the open revision always stays live.
- **Use:** being published, becoming visible, or receiving a pointer or click. Scrolling to an old preview is not enough to promote it, so as not to evict the recent ones.
- **Snapshot:** when a live frame becomes stable on screen, the window captures its rectangle by `papercraft.snapshot/v1` and keeps the image by the key artifact, revision, theme and width (revisions are immutable). A dead frame shows the snapshot at the same size, with the last serialized scene, so pins, outlines and comments keep appearing.
- **Promotion:** a pointer or click on a dead preview remounts it; the snapshot stays until the new frame reports that it rendered. The interactive state of a dead frame (an open section, a typed text) is lost.
- **No snapshot yet:** a placeholder with the preview's size and title.

## Accepted risks

- The first paint of each preview gets slower: each frame evaluates its own React (optimize later).
- A component that depends on persistent storage or on cookies sees only the frame's memory.
- Revisions published before this design now mount inside the frame with the same `mount`, but bring their portal container and their CSS with `:host`: they are isolated, without gaining the simplifications.
