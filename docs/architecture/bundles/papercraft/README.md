# Papercraft

**Status:** replaced on 2026-11-06 by papercraft on OpenUI, described in [docs/features/papercraft.md](../../../features/papercraft.md) and in [docs/designs/papercraft-openui.md](../../../designs/papercraft-openui.md). The `preview` kind, `papercraft.previews/v1`, the `papercraft_preview` tool, the `papercraft-preview` skill, the artifact frame and the approval no longer exist: the agent writes an OpenUI Lang program in a `papercraft` fence of its answer, and the decision "the artifact is code, not JSON" below was reversed. The iframe isolation of 2026-10-27 still holds ([isolation](isolamento.md)). The text below stays as a historical record.

## Summary

Papercraft lets the agent **show** a visual change instead of describing it. The agent delivers **real code** — HTML, a component of the Project or the path of a file — and the preview appears as a node of the conversation, in a canvas the user drags, zooms and uses normally. Each preview is a **proposal** and a **window**: Doric is YOLO by default, so the agent publishes the preview and **goes straight on**, implementing the change — waiting for authorization only exists when the Project asks for review ([artifacts](../artifacts.md#the-review-policy)).

The preview is an **artifact** ([artifacts](../artifacts.md)): the registry that gives identity, revisions, anchors and comments to the agent's deliverables. Papercraft is the first **kind** (`kind`) of that registry — the `preview` —, and what this document calls the preview artifact is its instance.

Three decisions of the user shape this design, and the previous version of this document contradicted them:

- **The preview runs in an isolated iframe.** The first version of this design mounted the artifact in the app itself, in a shadow root, without an iframe; on 2026-10-27 the user changed that decision ([isolation](isolamento.md)). Each preview — in the node and in the route window — runs in an `<iframe sandbox="allow-scripts">` without `allow-same-origin`: opaque origin, its own realm, no preload and no access to the app's DOM. The frame document (`doric://app/frame/index.html`) and the module are served by the app's origin; the frame does not load a page from another origin. The host page with its own `partition` remains for what is not the app (`site`, third-party content).
- **The artifact is code, not JSON.** The agent writes HTML, a component, or points to a path. It does not describe the interface in a schema.
- **The derived structure is optional and derived.** When the canvas needs data to interact, it **derives** them from the DOM it rendered — like Glide's _scene graph_ — instead of asking the agent to author them.

The reference repository is [`SrivarsanK/Glide`](https://github.com/SrivarsanK/Glide): a local visual editor that shows the running app in a canvas, lets you select, drag and resize elements, and **writes back to the source code** through AST codemods, with a component registry for agents, bidirectional sync and a staging buffer of edits. The section [Inheritance from Glide](#inheritance-from-glide) maps each of its pieces to what Doric already has.

## Inheritance from Glide

| Glide piece                                                        | In Doric                                                                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Canvas with selection, drag, resize, zoom and pan                  | Element of the `papercraft` bundle, hosted in the chat node by a `DecoratorNode`                                                 |
| _In-memory scene graph_ with cached bounds, hit-testing under zoom | Derived in the client from the mounted DOM, in the canvas element; none of it becomes an event payload                           |
| `glideSourceStamping`: elements stamped with file and line         | The preview build stamps the same `data-*`; it is what gives the comment an exact anchor                                         |
| `glide-components.json`: registry the agent reads by name          | Index of the Project's components, read by the agent before choosing what to preview                                             |
| Visual edits → AST codemod → source file                           | Real implementation, by the agent, in the Project's code — the preview shows what it does                                        |
| _Staged edits buffer_ before writing                               | The `artifacts.revised/v1` event and the new revision: the working copy is the staging                                           |
| `glide-positions.json` during the drag, so as not to restart HMR   | Local drag state in the canvas; none of it enters the durable log                                                                |
| File watcher → bidirectional sync without reloading                | `files.refresh/v1` and the events the preview already produces; the update becomes a revision, not a hidden mutation             |
| HTTP + WebSocket proxy on port 7777                                | Resident relay on the origin the host already exposes, like `screen-relay`/`ports`                                               |
| Skills (`glide`, `glide-component-segregator`, `glide-setup`)      | Skill `papercraft-preview`, with the judgment of when to preview and the flow of publishing and revising                         |
| Canvas UI in an iframe (proxy of the app)                          | **Do not copy:** the canvas belongs to the app; only the preview runs in a sandboxed iframe of the app's origin, without a proxy |

## The artifact: Project code, referenced by the event

The agent writes **files** with the tools it already has (`write`, `edit`) or through the papercraft tool. The durable event carries only the reference: identifier, revision, path and title. The log has append and document limits (`maxAppendBytes`/`maxDocumentBytes`, covered by `packages/storage/src/conformance/limits.ts`) and a payload with a closed schema — HTML does not belong there.

The three sources of the preview (the `source` field of the payload):

| Source      | What the agent provides                                    | How the preview loads                                       |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| `html`      | A self-contained HTML, with CSS (and JS, when interactive) | The document is wrapped in a module and mounted; see path B |
| `component` | The path of a component of the Project, or a new file      | The host compiles the component; the node mounts the module |
| `site`      | A server path of the Project (dev server, build)           | The canvas window points to the host; see path C            |

The artifact's directory, in the central registry ([artifacts](../artifacts.md#where-it-lives)), at the root of the Project's workspace:

```
/workspace/.doric/artifacts/<artifactId>/
  index.html         # o payload do tipo `preview`, origem `html` ou `component`
  artifact.json      # manifesto pequeno: tipo, título, revisão, âncoras, entradas
```

The directory lives in the Project's workspace — which the Threads share —, and the registry reaches it through the lease, as `files` does. It starts ignored by Git, and versioning an artifact is the user's choice, because the deliverable that gets versioned is the diff of the real code, and not a format conversion. The durable event carries the revision's entries (`path` + `sha256`), never the bytes: the directory is the working copy, and the durable truth is the log.

**On "converting into another structure".** The preview does not convert the component into JSON. What exists is a structure **derived at render time**, of the same kind Glide keeps: a tree of nodes with bounds, tag, classes and the stamped origin, which serves for hit-testing under zoom, selection, layers and for anchoring a comment to a point of the artifact. That structure is a local cache of the canvas, disposable, rebuilt on each render — it is not a contract, it is not an event payload and it requires nothing of the agent.

## How the preview reaches the screen

The platform facts that constrain the answer:

- The shell of each window is served by `doric://app`, with the import map and the theme injected per request (`app/desktop/doric/src/platform/protocol/shell.ts`); the handler serves `/platform/`, `/bundles/`, `/schemas/` and `/artifacts/` from disk, the document of the preview frame and its `boot.js` at `/frame/` (`protocol/frame.ts`), and returns the shell for any other path (`app/desktop/doric/src/platform/protocol/handler.ts`).
- The shell's packaged CSP is `default-src 'none'`, `script-src 'self' '<hash do import map>'`, `style-src 'self' 'unsafe-inline'`, `frame-src doric://app/frame/`, `connect-src 'none'`, `frame-ancestors 'none'` (`app/desktop/doric/src/platform/protocol/csp.ts`). That is: inline style is allowed, dynamic script is not, and the only framed document is the preview frame. The frame's CSP, in a header, names `doric://app` in place of `'self'` (the origin is opaque), also has `connect-src 'none'` and only accepts being framed by the shell (`frame-ancestors doric://app`).
- The shell **never opens HTTP or Socket.IO**: the preload exposes only `window.doric.desktop`, and every call to the host or to the desktop is a contract call routed by the main's dispatcher (`app/desktop/doric-renderer/AGENTS.md:28-33`). The preview's content reaches the node by contract, not by `fetch`.
- The app provides React, ReactDOM, Lexical, Base UI, `zod`, the shadcn registry (`desktop/ui`) and `bundle/contracts` through the import map, and `desktop/ui/theme.css` emits once the preflight, the tokens and the component classes; each bundle compiles only the utilities of its own classes (`docs/architecture/bundles/platform-packages.md`). The preview frame has its own import map, with only React, ReactDOM and the Base UI specifiers, as absolute URLs `doric://app/platform/…` (not `lucide-react`: the artifact's build bundles it).
- The platform build already uses esbuild and the Tailwind compiler (`app/desktop/doric-platform/build.mjs:16-17,484-492`), so compiling an artifact in the host introduces no new dependency in the workspace.

With that, three paths, in order of cost:

**Path A — render in the host, mount in the app (the fallback).** The host compiles the artifact (esbuild, with the import map's specifiers as externals) and renders it: self-contained HTML passes as it is; a component becomes markup through `react-dom/server`. The host also runs a Tailwind pass over the artifact's sources, so that its classes exist in a CSS that goes with the markup. The node receives markup and CSS by a contract call and hands them to the preview frame, which puts them in its own document (the `<style>` in the `<head>`, the body in the `<body>`) without running any script; the canvas (pan, zoom, selection, comments) is the bundle's chrome, on top of the iframe. The artifact's scripts do **not** run through this path, and it is that restriction that keeps A cheap.

**Path B — live module in the node (decided).** For the artifact to react in the node, the compiled module has to be served by the **app's origin**: the frame's CSP (`script-src doric://app`) does not allow importing script from `blob:` or from another origin. B does not invent a new machine; it reuses the one that already distributes bundles:

| Piece B reuses                                                                          | Where it lives today                                                                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cache verified by SHA-256, with staging on the same volume and atomic rename            | `ArtifactCache`, `app/desktop/doric/src/platform/catalog/artifacts.ts:1-5,45-70`                                                |
| Bytes by hash, with the host rereading the file and checking the SHA-256 before serving | `doric.catalog/v1.artifact({ sha256 })` → `{ sha256, base64 }`, `packages/bundle/src/contracts/platform.ts:406-415,586-593`     |
| Route that serves a verified directory under the app's origin, with a path guard        | `route` and `insideRoot` in `handler.ts`, for `/bundles/<id>@<version>/…` and `/artifacts/<id>@<revision>/…`                    |
| Module import by URL                                                                    | the frame runtime, `bundles/features/papercraft/src/client/frames/preview/runtime.ts`, as `ImportPart` does in the window       |
| List of specifiers that stay external (React, ReactDOM, Base UI)                        | `previewExternals` in `src/host/bundle.ts`, the frame's import map (`frameExternals`, `packages/bundle/src/build/externals.ts`) |

The flow is: the host compiles the artifact with esbuild using the same externals, generates the CSS and computes the SHA-256 of each file; the durable event carries only the revision's `{ path, sha256 }`; the `desktopMain` fetches each hash through `artifacts/v1.read`, verifies it and writes it to `userData/artifacts/<artifactId>@<revision>/` with the same staging and rename machine; the handler gains the `/artifacts/` prefix and serves that folder; and the node's element — trusted bundle code — opens the preview iframe and passes the module's URL to the frame runtime, which does `import('doric://app/artifacts/<artifactId>@<revision>/index.js')` and calls `mount` on a `#root` of the frame's `<body>`, with an error boundary and disposal on unmount. Bare specifiers resolve through the frame's import map, which points to the same `/platform/` files as the window: the preview loads the same React and the same Base UI, but evaluates its own instances, in its realm.

```
userData/artifacts/<artifactId>@<revision>/
  index.js           # o módulo ESM, verificado por hash
  index.css          # o Tailwind do artefato, compilado junto
```

What B costs, beyond the platform surface (the route, the fetch, the serve and their tests): the module is Project code running inside the app. The first version mounted it in the **same realm** as the shell, where it reached the app's DOM, the globals and the `window.doric` bridge, and accepted that; since 2026-10-27 it runs in the sandboxed iframe of opaque origin ([isolation](isolamento.md)): its own realm, no preload or `window.doric`, with `localStorage` and `sessionStorage` in memory, without the app's DOM, and only a `MessageChannel` with the app, which treats each message from the frame as untrusted data. The frame only navigates to the frame document (`will-frame-navigate`), and Electron puts it in a separate renderer process (`IsolateSandboxedIframes`). Two technical obligations come with B: the cache key has to include the `PLATFORM_VERSION` (a preview compiled against `desktop/ui@1.0.0` is not valid on a 2.0.0 platform, as `engines.doric` already resolves for bundles) and A's static markup remains the fallback when the module does not load. The preview build is agnostic to the Project: the frame's import map serves only the React and ReactDOM with which `mount` renders, and Base UI; the host provisions only `lucide-react` (whose file structure would cost too many sandbox reads) and, in the leaf, Tailwind and a generic theme; everything else is Project code, read from its files and its `node_modules` and bundled — and nothing is special to Doric: when the Project is Doric itself, its `desktop/ui`, `bundle/contracts`, zod and Lexical are Project code, so an edited or created component appears as the Project has it. Packages are resolved by the `customConditions` of the nearest tsconfig, which takes a workspace package to its source. No import is refused for what it names: the module runs in the isolated frame, whose opaque origin, lack of preload and CSP are the boundary; only what does not run in a window fails or, when the host bundles through `files/v1`, what exceeds the read budget, naming the import.

**Path C — the viewing window (host page).** Where the content **is not the app**: the window loads a host page, with its own `partition` and no preload, exactly as the `screen` bundle opens a Project's screen (`bundles/features/screen/src/desktop/windows.ts`). The resident `papercraft-relay` serves the page from the artifact and mounts the comment layer; the token is the capability, as in `screen-relay` (`bundles/features/screen-relay/src/host/relay.ts:1-24`).

With B decided, C **is not the v1 path**: the canvas window is an **app route window** (below), which reuses the same modules, services and the same preview frame. C is left for `site` (the Project's dev server) and for third-party content — the case in which its own partition and the token as capability are the point; it depends on `ports` existing.

Decided: **B in the node and the route window for the canvas**. The user sees and comments on the preview in the conversation from day one, and the window is the same surface in full screen.

## The canvas

The canvas is the bundle's own chrome, rendered in the node and (in full screen) in the window:

- **viewport**: pan and zoom with a transform; hit-testing uses the derived tree with cached bounds, not `document.elementFromPoint`, because a canvas with a transform breaks the direct position test — Glide's lesson.
- **selection and layers**: select the element under the pointer, see the tree, hide and focus.
- **drag and reposition**: move elements and the canvas itself; none of this is durable until the user comments.
- **comment pins**: anchored to the selected node and to its stamped origin.

What is local and what is durable:

| State                          | Where it lives                      | Why                                                      |
| ------------------------------ | ----------------------------------- | -------------------------------------------------------- |
| Pan, zoom, window size         | Local view, per node and per window | Replay must not return the user to an old position       |
| Selection, hidden layers, drag | Local view                          | It is exploration, not decision                          |
| Derived tree (scene graph)     | Canvas cache, rebuilt               | Derived from the mounted DOM; disposable by definition   |
| Comments and their anchors     | Durable, in the comment's event     | It is what the agent reads and what the transcript shows |
| Revisions                      | Durable                             | It is the record of what was proposed and of what came   |

## The UI in the node and in the window

The two homes of the preview — the conversation node and the canvas window — share the same UI code and the same durable state. The chrome is **minimal** in both: the screen is the preview, and the controls are a header that floats over the canvas.

### One surface, two frames

What draws the preview lives in `bundles/features/papercraft/src/client/surface/`:

- `preview-container.tsx` — the preview's container: the canvas that scrolls behind the overlay header (`preview-header.tsx`) and the comment flow.
- `preview-surface.tsx` — the component that hosts the artifact: it writes the revision to the verified cache, starts the frame with the module's URL (`doric://app/artifacts/<artifactId>@<revision>/index.js`), the URL of `index.css` and A's markup as a fallback, passes only the reader's light or dark mode (it does not copy the app's theme) and sizes the iframe by the layout and by the size the frame reports.
- `live-frame.tsx` — the `<iframe sandbox="allow-scripts">` and the `MessageChannel` with the frame's runtime (`src/client/frames/preview.ts`); the protocol and the schemas that validate what comes from the frame are in `src/client/frame-protocol.ts`, and `frame-memory.ts` keeps the last scene, size and layout of each revision.
- `scene-graph.ts` — the derived tree: the frame's runtime walks its own DOM and sends the serialized tree (the `scene` message), with bounds in CSS px of the frame's document; the app matches the `data-*` stamp with the anchors and caches the bounds. It is what allows hit-testing with pan/zoom without `document.elementFromPoint`, and it is what resolves the element under a click in empty space. Out-of-flow `::before` / `::after` (`absolute` / `fixed`) are not nodes of the tree and do not widen the host's bounds: they are separate **targets** (`SceneTarget`, id `n4::after`), measured in `Scene.pseudoBounds`; the tree, hiding, isolating and framing know only the host.
- `pins-layer.tsx` — the teardrop pins (with the author's avatar and the thread's state) and the comment field, in the app's document, over the iframe; `comment-field.tsx` is the inline field, `thread-popover.tsx` the thread popover of a pin that already has the first comment, and `thread-log.ts`/`threads-view.ts` group the log's comments into threads (one `watchThread` shared by the Thread and the window, with `comments/v1.list` as a fallback).
- The stack's line is **not** papercraft's: its own comment card was removed, and the stack uses `chat`'s `chat-comment-line`, the same element as in the user's turn.
- `command-toolbar.tsx` — the window's command bar: the four groups of controls, the dividers and the arming of the tool ([below](#the-command-bar)).
- `tree-panel.tsx` — the window's tree, over the same `scene-graph`.
- `domain/preview-state.ts` — the pure reducer of the `artifacts.*` events into a `PreviewState`, the same one used by the chat's projector and by the window.

The node's frame uses `chrome: 'node'`; the window's, `chrome: 'canvas'`.

### The conversation node

The node is a **square**: it takes the width of the conversation's block and has the same height — it does not resize. It is the body of the frame of the [artifact registry](../artifacts.md), and the `preview` kind declares `header: 'body'`: the frame does not draw its bar (title, kind, revision, `Comentar`) and keeps below the body only what belongs to the registry — `Autorizar`, under `request` and on an open revision. There is no list of revisions: the conversation, with the agent's answers, is the history.

The **header is an overlay**, in the node and in the window: a transparent strip, over the canvas, that takes the whole container from the top and scrolls behind it. On the left, the file name (or the title) and the revision in a faded tone (`rev 2`); on the right, only icon buttons with a tooltip and `aria-label` — `abrir` (`ExternalLink`, only in the node), which opens the window on that preview, and `Comentar` (a speech bubble), pressed (`aria-pressed`) while comment mode is on, with a small counter of the pending comments and of the drafts. The canvas chrome uses Noto Sans at weight 400, and not the monospaced font of the conversation around it.

Each revision **opens centered**: when the content is measured for the first time, the view frames the element — not the page around it (the `body` and the page-width containers, such as a `main` that centers a card) —, shrinking to fit and never enlarging. Pan and zoom after that are the reader's. The measure is of what shows: each element counts only by the part that the ancestors that clip overflow leave visible (what scrolled out of a scroll area does not count), and an element without area — such as the module's own `display: contents` wrappers, which the browser measures at the window's corner — neither bounds the content nor responds to the pointer.

The preview of a **component hugs its content**: the host has the width of what the story renders, up to the width of the canvas, like Storybook's `centered` layout — and a background that the harness paints becomes a frame around the component, instead of a strip the width of the window. The story or the harness that needs the full width declares Storybook's `parameters.layout`: `padded` or `fullscreen` mount the preview at the width of the canvas (Storybook's padding is not reproduced, because the canvas already surrounds the preview). An `html` preview is a page and stays at the width of the canvas.

In the node's footer, centered and floating over the canvas, are the view controls: zoom out, the zoom readout (a click returns to 100%), zoom in and `Centralizar`, which frames the element again. The window has its own command bar and does not show that footer.

```text
╭──────────────────────────────────────────────────────────╮
│ Checkout.tsx  rev 1                              ⧉  💬 2 │
│                                                          │
│         Checkout                                         │
│         ────────────────────                             │
│                                                          │
│         Subtotal             R$ 128,00                   │
│         Frete                R$  12,00                   │
│                                                          │
│         ┌──────────────────────┐                         │
│         │     Pagar agora      │                         │
│         └──────────────────────┘                         │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

**The comment flow is Figma's.**

1. The `Comentar` button — or the `C` key, with the canvas in focus — turns _comment mode_ on and off; the pointer becomes a **comment bubble**, which stays a bubble over any element of the artifact, whatever cursor that element declares. `Esc` closes the open field and, with no open field, leaves the mode.
2. Under the pointer, the element that will receive the comment gets a **dashed** outline with a light tint of the primary color — distinct from the selection's solid outline. In empty space there is no outline: the comment is a free position, anchored to the nearest element. Holding `Alt` forces the free position even over an element. An out-of-flow `::before` / `::after` is a target of its own: under it, the outline is the pseudo-element's box and the label names it after the host (`span.badge::after · arquivo:linha`).
3. The click puts at the point a **teardrop pin** (round, except the bottom-left corner, which touches the point; in the primary color) and, to its right (to its left, when the canvas has no room — never over the pin), the **comment field**, in a popover with the same surface as the thread popover (the theme's popover background, border, radius and shadow): the field (`Adicionar comentário`, in Noto Sans) with the send button **outside** it, but inside the popover (↑, 28px, neutral and disabled while empty, primary with text), already in focus. While the field — or a thread — is open, the pointer's `elemento · arquivo:linha` label disappears, so as not to cover the field or the pin. Empty, it is one line with the ↑ beside it; once the first character is written, the note sits on top and the ↑ below, on the right. Pin and field sit in a layer above the transformed content — they do not scale, they follow the pan and the zoom and they stay inside the canvas.
4. `Enter` or ↑ **confirm**: only then does the comment enter the stack above the prompt as a draft ([below](#comments-above-the-prompt-draft-in-the-host)). `Shift+Enter` breaks the line; `Esc` cancels; clicking outside discards an empty field and confirms a written one. Confirming and canceling return the focus to the canvas before the field disappears, so the mode stays on and `C`, `Esc` and the next click — which starts another comment — apply at once. After a click outside, the node loses focus: the next touch on it only focuses it.
5. Each confirmed draft is a pin: the raised teardrop with the **author's avatar** inside — the same identicon of the name that the conversation draws (`ReaderAvatar`) — and the number in the accessible label. Clicking the pin reopens the same field, filled in, to edit the note or remove the draft — and it is the same draft as the stack's: editing in the stack changes the canvas, and vice versa. A comment already sent is also a pin, and the pin that already holds the first comment opens the **thread popover** ([below](#threads-on-the-canvas)).
6. On an element, the pin keeps where the click fell inside its box (fractions, the anchor's extra key `offset`), so it follows the layout and the zoom, and it also keeps the clicked point of the content (`x`, `y`, keys that every form accepts); a free position keeps the content's coordinates. It also keeps the element's identity beyond the selector: an excerpt of the text (`text`, whitespace collapsed) and `index`, its order among the elements of the same selector (the stamped ones of the same file, when stamped). In a later revision the agent may have edited the file and changed every line, so the pin returns only to an element of the **same selector**: the exact `path:line` when it is the only one there; otherwise, among the selector's elements stamped from the file (or all of the selector's), the one with the same text, then the one with the recorded `index`, the only one, the one under the recorded `x`/`y` point (or the nearest to it) and, last, the one with the nearest line; with none, the recorded point. Never an element of another selector. A comment on a `::before` / `::after` keeps the anchor's `pseudo` key (and the `label` `tag::after`), and the `offset` is measured inside the pseudo-element's box; the element is still resolved by the host, and, when the pseudo-element draws no box in the revision on screen, the pin returns to the host's box. The anchor the agent reads does not change meaning: the forms `source`, `selector` and `point` and the stamp `data-papercraft-source` are the same.

**Draft until the send.** Confirmed comments remain drafts in the stack until a prompt is sent — the usual flush writes them as `comments.added/v1` and wakes the agent. `Cmd/Ctrl+Enter` **sends now**, with the focus anywhere in the window — in the conversation it is `chat`'s own send (`chat.send-prompt/v1`), which first asks (`doric:prompt-send`) and waits for the note open on the canvas to enter the stack; in the canvas window it is `papercraft.send/v1`, which confirms the open note and sends through `chat.send/v1`; neither the canvas nor the field answers the shortcut on its own: the prompt goes out with the stack (it can go out with the stack alone), by the same path as the chat's send button — the stack's comments in the prompt's `<comments>` envelope ([comments](../comments.md#the-prompt-the-xml-envelope)), the draft text the host keeps, the flush after the acceptance and the items whose write failed back in the stack. The window, which has no prompt, gets in its header the `Enviar ao agente (n)` button while there are drafts. The send is the client service `chat.send/v1` (`send({ projectId, threadId })`) that `chat` provides in each window — it includes the draft text the host keeps and clears it after the acceptance: `chat.composer/v1` runs in the main process, which does not call the host's contracts.

```text
╭──────────────────────────────────────────────────────────╮
│ Checkout.tsx  rev 1                              ⧉  💬 1 │
│                                                          │
│         Checkout                                         │
│         ────────────────────                             │
│         ┌──────────────────────┐                         │
│         ┆     Pagar agora   ●  ┆ ╭───────────────────╮   │
│         └──────────────────────┘ │ mais respiro…  (↑)│   │
│                                  ╰───────────────────╯   │
│             (1)                                          │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

**Pan with the space bar.** The node is square and not every artifact fits in it: holding the space bar the pointer becomes `grab`/`grabbing` and dragging moves the canvas, as in Figma; releasing the bar returns the pointer to the previous mode, without losing the comment in progress. The same gesture works on the window's canvas. Because the node lives inside the conversation's editor, the space bar belongs to the canvas only while the pointer is over it — the canvas takes the focus when pressed, and the space bar still belongs to whoever is writing the prompt.

When the module does not load, the canvas is not left empty: the notice is a discreet line and A's static markup appears in its place (decision 10).

```text
╭──────────────────────────────────────────────────────────╮
│ Checkout.tsx                                   [ abrir ] │
│                                                          │
│ o preview não carregou · mostrando o markup de A         │
│                                                          │
│         Checkout                                         │
│         ────────────────────                             │
│                                                          │
│         Subtotal             R$ 128,00                   │
│         Frete                R$  12,00                   │
│                                                          │
│         ┌──────────────────────┐                         │
│         │     Pagar agora      │                         │
│         └──────────────────────┘                         │
│                                                          │
│                                                      (o) │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

### Comments above the prompt, draft in the host

The comment has a single place where it is written, and it is the **stack above the user's prompt**: one element per comment, **single line**, one on top of the other between the last turn and the prompt block — the same pattern as the lines of the message queue (`thread-queue.tsx:95-105`), which brings the author and the truncated text on the same line. Each line is `chat`'s `chat-comment-line`: the **avatar** of whoever commented — the jdenticon of the name, the same `ReaderAvatar` as in the queue and in the turn's author line (`bundles/desktop/chat/src/client/components/molecules/prompt-author.tsx`) —, the `↩` when it is a reply, the **author**, the **note** (a `contenteditable`, edited right there) and, at the end, the **file and line** (or the position, in an empty-space comment) with the `[pino]`.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   (js) jao.scheuermann  aumenta o respiro do botão e…    [1] Checkout.tsx:42 │
│   (js) jao.scheuermann  falta espaço aqui           [2] espaço em (412, 180) │
│                                                                              │
│  Adiciona o espaçamento entre os itens do carrinho                           │
│                                                                              │
│                                                                      Cmd + ↵ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The note is written on the canvas, in the field next to the pin; confirming it (`Enter` or ↑) adds a line to the stack, with the note. Nothing touches the stack while the note is being written, and nothing enters the log while it is a draft. After that the note is edited **in the line itself**, without a popover or buttons, with the stack's keyboard: ↑/↓ move between the notes and the prompt, `Enter` goes to the next one, `Esc` returns to the prompt, `Cmd/Ctrl+Backspace` (or `Backspace`/`Delete` on an empty note) deletes the line and `Cmd/Ctrl+Enter` sends.

The stack item keeps `{ target, pin, point, refs: { title, source }, inReplyTo? }`; its `id` is the `comment-<uuid>` that becomes the event's `commentId`. The flush writes `commentId` and `inReplyTo` in the stack's order — a reply waits while the root is a draft — and still reads drafts in the old format.

The send is the **flush**: when the prompt is sent, each element becomes a `comments.added/v1` event ([comments](../comments.md)) and the stack empties. The send now also counts the stack's elements: today the button is enabled only with words in the editor, and a comment alone is already something to send.

In the user's turn, the comments appear **with the prompt**: the same lines, with the same avatar, above the text the user wrote. Clicking a line leads to the artifact's most recent preview, with the thread open.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│   (js) jao.scheuermann  aumenta o respiro do botão e…    [1] Checkout.tsx:42 │
│   (js) jao.scheuermann  falta espaço aqui           [2] espaço em (412, 180) │
│                                                                              │
│  Adiciona o espaçamento entre os itens do carrinho                           │
│                                                                              │
│                                                                         Você │
╰──────────────────────────────────────────────────────────────────────────────╯
```

After the flush, what remains is the log. The turn's line is born from the event, through the projector, and not from the composer's state — that is what makes replay and rewind rebuild the comments like everything else. And it is the **same element** in both places: `chat-comment-line` draws it with two providers, the stack (not yet durable) and the projector's block (durable).

**The draft lives in the host.** The prompt's text and the stack of comments are **a single state**, and it lives in the main process, in a new service — `chat.composer/v1` —, provided by a `desktop` part of `chat` (the same design as `history`, which serves `history.snapshots/v1` from `src/desktop`). The state is keyed by `(projectId, threadId)`, and every window reads it and subscribes to it: `read({ threadId })` for the snapshot and `watch(threadId, listener)` for the deltas, in the format of `runtime.threads/v1.watchThread` — snapshot first, then the live items, with `StreamListener<T>`. So the draft **survives navigation** (switching conversation, switching route, opening the canvas) and **is the same in any window of the front end**: today it lives only in the `threadChatsStore` of the window that wrote it (`stores/thread-chats.ts`), so a second window opens the conversation empty.

**How the stack is stitched together.** The canvas is `papercraft`'s; the composer is `chat`'s. The state is the host's, but whoever **draws** the element and whoever **writes** the event belong to the bundle that owns the kind: the item keeps `{ id, kind, elementTag, data, author, note }` and `chat` resolves the `elementTag` as it resolves a conversation block (`chat.views/v1.registerRenderer`); the `flush()` that the owner registers for its `kind` is what the send calls, and it is what writes the event through `artifacts/v1`, without `chat` knowing what a comment is. A second use — commenting on the agent's answer, outside this delivery — is another `kind` in the same stack, with the same element and the same `flush`.

The flush runs **after** the host accepts the prompt (`send(text)` returns the acceptance) — also in the canvas's send (`Cmd/Ctrl+Enter`, `chat.send/v1`), which is the same path without the editor's words: a refused send returns the words to the editor (`$restore`, `send-prompt.tsx`) and the stack stays where it is. The events enter the log in the order in which they were written, and the block is born anchored by the `sequence` right below the user's turn (`insert-thread-turn-nodes.tsx`).

### Threads on the canvas

The log's comments are grouped into **threads** (the root and its replies, [comments](../comments.md#threads-states-and-the-agents-replies)), and the pin shows the thread's state by its **color** (the pin's drawing is a component shared with the conversation, `desktop/ui/comment-pin`, in three sizes — the canvas uses the medium one):

| State   | Pin                              |
| ------- | -------------------------------- |
| Draft   | Dashed                           |
| `open`  | Primary                          |
| `await` | Orange (the agent answered last) |
| `done`  | Green                            |

Threads **cross revisions**: the canvas shows all of the artifact's threads (and its drafts) in the revision on screen — the newest, by default —, each with the same number in any revision. The pin re-places itself by the anchor in the revision on screen; when the element no longer exists there, the pin goes to the point the anchor kept and, with no kept point (old comments), it is **detached**, stacked on the left edge of the content — it is still counted and opens the thread. A new comment is written against the revision on screen; a reply, against the root's target (the revision in which the root was written), and resolving works in any revision.

Canceling the thread (`Esc`) or closing it with the close button returns the focus to the canvas, like the comment field; removing the root draft of the open thread does not return it.

A control shows or hides the resolved threads. Moving the pointer over an element shows the dashed outline with the `elemento · arquivo:linha` label in any mode, with the frame in focus or not: with the comment tool armed, on the element that will receive the comment; outside it, on the element under the pointer. Over an out-of-flow `::before` / `::after`, the outline and the label are the pseudo-element's, and clicking it with the selection tool selects it. Nothing is outlined while the canvas pans, and the outline disappears when the pointer leaves the canvas. **Opening a pin that already holds the first comment** shows the thread popover: the header (`N Componente:linha`), the `⋯` menu, resolve or reopen (on roots already sent) and close; the messages, with avatar, name and time; and the reply field. A reply goes to the **stack** with `inReplyTo` and goes out on the next send, like any draft (which stays editable and removable); resolving calls `comments/v1.resolve` on the root, under the root's own `promptId`. The node listens for the DOM event `doric:comment-thread-open` (`detail: { commentId, target }`) that `chat` dispatches from the answer blocks and from the markers, and opens the thread of the matching pin: with `target.revision`, only the node of that revision answers; without it — the newest —, only the node of the artifact's newest revision (which it asks the registry for). The canvas window does not receive that event.

### The canvas window

The window is the same surface in full screen, with the same minimal chrome:

- **overlay header** — the macOS traffic lights on the left and the file name beside them. The window opens with `appearance.titleBar: 'integrated'` (the contract's default), which on macOS uses `titleBarStyle: 'hidden'` with `trafficLightPosition` and reserves the safe area on the left (`app/desktop/doric/src/platform/windows/appearance.ts:26-56`); the header is the app's `ChromeBar` (`packages/desktop/src/chrome-bar.tsx`), the draggable strip of `--doric-titlebar-height` with `ps-(--doric-safe-left)`, which keeps the traffic lights clickable and the rest of the bar draggable. The canvas flows behind it, as in the node.
- **tree on the left** — the derived structure of the rendered artifact (the same `scene-graph`), with the selected node highlighted; clicking selects, and the selection lights up the element on the canvas.
- **command bar** — a floating bar, centered on the bottom edge of the canvas, with the window's controls grouped: tool, selection, viewport and proposal. It is the window's only action chrome: the comment comes in by the same gesture as in the node (element or free position) and falls into the same stack, and the rest are the bundle's commands. The design is in [The command bar](#the-command-bar).
- **no footer** — nothing below the canvas.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ (o)(o)(o)  Checkout.tsx                                                      │
│                                                                              │
│ ╭ estrutura ───╮                                                             │
│ │ Page         │    Checkout                                                 │
│ │  main        │    ──────────────────────                                   │
│ │   section    │                                                             │
│ │    h1        │    Subtotal                                       R$ 128,00 │
│ │    > button  │    Frete                                          R$  12,00 │
│ │    ul        │                                                             │
│ ╰──────────────╯      ┌────────────────────────┐                             │
│                       │      Pagar agora       │  [1]                        │
│                       └────────────────────────┘                             │
│                                                                              │
│                           [2]                                                │
│                                                                              │
│                                                                              │
│      ╭────────────────────────────────────────────────────────────────────╮  │
│      │  ▸  ⊙ ¹  ✋   │   ⌖  ◎   │  −  100%  +  ⤢  │  rev 1/1               │  │
│      ╰────────────────────────────────────────────────────────────────────╯  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The window is an **app route**, the same kind as the settings window:

- the bundle registers `/papercraft/:artifactId` with `navigation/v1`, whose element is `<papercraft-canvas>`;
- the desktop part registers the command `papercraft.open-canvas/v1` (on the model of `core.open-settings/v1`, `bundles/foundation/core/src/desktop/commands.ts:22-39`) and calls `windows/v1.open({ key: <artifactId>, path: '/papercraft/<artifactId>', appearance })`; the core prefixes the key with the bundle's id (`bundles/foundation/core/src/desktop/windows.ts:44-52`), so the window is stable per preview and a second click focuses the existing one;
- `/papercraft/…` is not a file: the handler returns the shell (`handler.ts:130`), `<core-outlet>` renders the bundle's route (`bundles/foundation/core/src/client/elements/outlet.ts:135`) and the window has the preload, the import map and the services of any other.

**Why not a partition here.** The window with its own `partition` is the `view` window of `windows/v1`: a host page, without preload or contracts (`packages/bundle/src/contracts/basic/windows.ts:53-83`). With B decided, the artifact already runs in the app's origin; a `view` would force the canvas chrome to live in a page served by the host, with its own UI runtime and a transport through a relay — the whole path C — to talk to the host again. The partition still makes sense for `site` and third-party content.

#### The command bar

The free-text trail (`/ comentar · isolar · autorizar`) forced the user to guess: it did not say what was **armed**, what was **available at that moment**, nor what each verb did with the selection. The same verbs become a **command bar** — explicit, grouped controls, in the bottom-bar design that canvas editors use.

The bar is an **overlay**, like the header: it floats over the canvas, centered on the bottom edge, with a margin from the container, rounded corners, a border, a translucent background with blur and a shadow — the canvas keeps scrolling behind it and still has no footer. It is built with the registry's components (`desktop/ui/<componente>`, `docs/architecture/bundles/platform-packages.md:19`), not with its own CSS: `ToggleGroup`/`Toggle` for the armed tool, `Button size="icon-sm" variant="ghost"` for the others, `Tooltip` with a `<kbd>` in its content for the label and the shortcut (`packages/desktop/src/components/tooltip.tsx:44`), `Badge` for the pin count, a vertical `Separator` shorter than the bar between the groups — the `ToolbarDivider` of the message composer (`bundles/desktop/chat/src/client/components/molecules/toolbar-divider.tsx`) — and `lucide` icons, the registry's library (`packages/desktop/components.json`).

**Four groups, three dividers.** From left to right: the armed tool, what is done with the selection, the viewport and the proposal.

| Group     | Control                                            | Command                         | Shortcut                | Enabled when                                                                      |
| --------- | -------------------------------------------------- | ------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| Tool      | Selecionar (`MousePointer2`)                       | `papercraft.select/v1`          | `V`                     | always; it is the one armed on entry                                              |
|           | Comentar (`MessageSquarePlus`, with the pin count) | `papercraft.comment/v1`         | `C`                     | always                                                                            |
|           | Mão (`Hand`)                                       | `papercraft.pan/v1`             | `H`                     | always                                                                            |
| Selection | Isolar (`Focus`, toggleable)                       | `papercraft.isolate/v1`         | `I`                     | a node is selected                                                                |
|           | Mostrar tudo (`Eye`)                               | `papercraft.show-all/v1`        | `Shift+I`               | there is a hidden or isolated layer                                               |
| Viewport  | Menos zoom (`ZoomOut`)                             | `papercraft.zoom-out/v1`        | `CmdOrCtrl+-`           | always                                                                            |
|           | Current zoom (`100%`, readout)                     | `papercraft.zoom-reset/v1`      | `CmdOrCtrl+0`           | always; a click returns to 100%                                                   |
|           | Mais zoom (`ZoomIn`)                               | `papercraft.zoom-in/v1`         | `CmdOrCtrl+=`           | always                                                                            |
|           | Ajustar (`Maximize`)                               | `papercraft.zoom-fit/v1`        | `Shift+1`               | always                                                                            |
| Proposal  | Revisão (`rev 1/1`, readout)                       | `papercraft.select-revision/v1` | —                       | there is more than one revision; opens a `DropdownMenu`                           |
|           | Autorizar (`Check`, primary, with a label)         | `papercraft.approve/v1`         | `CmdOrCtrl+Shift+Enter` | **only under the `request` policy**, and the revision on screen is not authorized |

Rules the bar follows:

- **The armed tool is a radio group, not three buttons.** Selecionar, Comentar and Mão are the `ToggleGroup`: only one at a time, and "Comentar" arms the same gesture as the node's button — the pointer becomes a bubble, the element under it gets an outline and the click falls into the composer's stack. The control carries the **pin count**, like the node's button.
- **No new state.** Each control reads a field of the `PreviewState` — the same reducer as the chat's projector and the window's — and dispatches through `commands/v1.execute`, the path that `git`'s Changes panel uses. The armed tool, the pan, the zoom, the selection and the isolation are **local view**, like the rest of the canvas ([above](#the-canvas)); what the bar writes to the log is only what was already durable: the comment (in the send's flush) and, under `request`, the authorization.
- **Disabled, not hidden.** A control that appears and disappears moves the pointer's target out from under the user; the controls stay in place and change state. The two exceptions are **readouts**: the revision exists only with more than one revision, and the authorization button becomes the readout `Autorizado` — without an action — when the revision has already been approved.
- **One label, once.** `Autorizar` — when the policy asks for it — is the only control with text besides the icon, because it is the action that releases the writing to the Project's code; the others are explained by the icon and by the tooltip, which shows the name and the shortcut.
- **Isolar is the verb the trail left loose and now has a place.** It hides the siblings of the selected node and keeps its chain visible — the close reading that the tree suggests; `Mostrar tudo` undoes the isolation and the layers hidden by hand.
- **Shortcuts without a modifier belong to this window only.** The client registers each shortcut with `menus/v1.addKeybinding` (owner = bundle, as in [native menus and keybindings](../menus-and-keybindings.md)), pointing to the command's id. `V`, `C`, `H` and `I` are bare keys and collide with nothing: **the canvas window has no text field** — the comment's note is written in the stack above the prompt, in the conversation — and the core gives each window the table already filtered for it (`packages/desktop/src/client/keybindings.ts:1-3`).
- **The bar belongs to the window; the node keeps the header.** The node (`chrome: 'node'`) draws only the icon buttons of the overlay header, because the conversation's width does not fit four groups; the window (`chrome: 'canvas'`) draws the same header and the whole bar. It is the `chrome` that decides which groups exist, and not a second surface.

With the minimal chrome, the node shows the revision it was created with and the window opens on the newest; the bar's `rev 1/1` readout is the only place on the screen where the revision appears, and it is what switches the revision on screen when there is more than one ([open decisions](#open-decisions)).

### States side by side (proposal)

**Status:** proposal, not yet implemented. Mockup: [states side by side](./mockups/states.html).

The preview gets **frames**: one frame per story of a stories file, each with its name on top, all on the same canvas, with the same pan, zoom and pins.

- **The frame is today's page, repeated.** The same `mount`, the same bundle and the same CSS, each frame in its own preview iframe, the surface's 8px margin and the theme's own background. The compilation is still a single one.
- **The theme is one more dimension.** `Claro`, `Escuro` or `Claro e escuro`; the last one puts each story twice, side by side. The `mount` already receives the `theme`.
- **Layout.** `Grade`, in two columns, or `Linha`, all in one row, over the dot grid, with 48px between columns and 72px between rows. The frame's name sits above it, in 11px and `muted-foreground`, and turns `primary` on hover and on the frame in focus.
- **Zoom on a frame.** Clicking the frame's name, on the canvas or in the structure, frames the frame and highlights it with the primary outline. `Ajustar` shows all of them again, discounting the area of the structure panel.

In the window:

- **The structure becomes a floating panel**, in the pattern of the command bar: a 1px border, `rounded-xl`, `p-1`, a `background/80` background with blur and `shadow-md`, 12px from the left and just below the header. The height follows the content and scrolls when it reaches the end of the canvas. It has no visible label; "estrutura" is only in the `aria-label`.
- **The frames sit at the first level.** Each frame is a group: the collapse arrow, the frame icon, the name in sans 12.5px medium and, when there are open comments on it, a counter. The elements sit below, indented, in mono 11.5px with the tag highlighted. A 1px divider separates one state from the other.
- **26px rows**, with a soft hover. The eye appears only on hover or focus, and stays fixed on a hidden frame or element. Hiding a frame takes it off the canvas; its comments stay in the thread.
- **A new control in the command bar:** the `N estados` menu, after the viewport group and before `rev n/m`, in the same dropdown pattern. It chooses the visible states, the theme and the layout.

In the node, the square, the header and the zoom footer are today's. The header gains `· N estados`, and the node opens fitted to the whole grid, in the light theme.

In the data:

- The tool accepts `entry` as a list of stories and `themes` (`light`, `dark`). An `entry` with one string is still a single frame.
- The anchor gains `frame`, the story's name. The same `arquivo:linha` exists in every frame, so the frame is part of the pin's identity, and the search of the [anchors](#anchors-the-agent-understands) runs inside the anchor's frame.
- In the chat, the comment's line carries the frame's name before the location: `Empty · div · CheckoutCard.tsx:58 [1]`.
- The artifact is modeled as a list of frames, so that the next step, frames from different files, changes neither the canvas nor the comments. That step brings the frame's stable `id` across revisions, one iframe per HTML frame, so that the CSS of one does not leak into the other, and the CSS as the union of the sources.

### Where the data comes from

| What                                             | Node                                                                               | Window                                                                                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revision and comments                            | the chat's projector over the log, directly in `block.data`                        | `artifacts/v1.read({ artifactId })` and `runtime.threads/v1.watchThread(threadId, 0)` filtered by `artifacts.*` and `comments.*`, with the same reducer |
| Selection, armed tool, pan/zoom, isolation, pins | the element's local state                                                          | the window's local state                                                                                                                                |
| Comment                                          | a card in the stack of `chat.composer/v1`; the flush writes `artifacts/v1.comment` | the same, through the bar's `Comentar` control                                                                                                          |
| Autorizar (only under `request`)                 | —                                                                                  | the bar's `Autorizar` button                                                                                                                            |

The window needs the `threadId` to subscribe to the log; `read` returns the record (thread, revision, anchors) and the rest comes from the stream. The draft and the stack do not go through the log: they are the composer's state, in the host, and each window subscribes to them through `chat.composer/v1`. In both cases the preview's state is rebuilt from the durable events; nothing of the UI becomes application state outside the log.

### What the build delivers

The compiled module (`index.js`) has a small contract, and the signature does not depend on React:

```ts
export interface PapercraftModule {
  /** Monta o preview no root e devolve o unmount. */
  mount(
    root: HTMLElement,
    context: { theme: 'light' | 'dark' },
  ): void | (() => void);
}
```

- `html` — the build wraps the document in the `mount` (the CSS becomes `index.css`).
- `component` — the build wraps the component in a `mount` that creates the root with the `createRoot` of the frame's import map: the React that the platform serves, evaluated in the frame's realm.
- The module is ESM with the import map's specifiers external, so `react`, `react-dom/client` and the `@base-ui/react` that the map serves resolve through the frame's map; the theme and the components come from the Project ([below](#harness-stories-and-portals)), not from the app.
- The frame's runtime links `index.css` with a `<link>`, puts the theme on the `<html>` (`class="dark"` in dark mode) and calls `mount(root, { theme })` on a `#root` of the `<body>`: the same contract as always, so revisions published before the frame mount without change.

### Harness, stories and portals

The preview runs in its own frame, with its own realm and React root, so no provider of the app reaches it. What the component needs comes from the **Project**, in versioned files in Storybook's format:

- **Harness.** The nearest one going up from the previewed file (skipping `.doric/` and `node_modules/`): `.storybook/preview.{tsx,ts,jsx,js}`, otherwise `.papercraft/preview.{tsx,ts,jsx,js}`. Supported subset: the `default` `{ decorators, parameters, args }` and/or the named exports. Type-only imports from `@storybook/*` disappear in the build; `@storybook/addon-themes` has a built-in substitute, which puts the theme's class or attribute on the `parentSelector` (`html` by default), as the addon does; the other imports go through the Project's resolution, and a harness that does not compile is left out with a warning — the preview compiles without it.
- **CSF stories.** A `*.stories.*` (or a `default` that looks like a CSF meta) mounts a story: `entry`, otherwise the first in source order. It renders `story.render(args, context)`, otherwise `meta.render`, otherwise `<meta.component {...args} />`, with `args = { ...preview.args, ...meta.args, ...story.args }`; decorators in Storybook's order (story → meta → harness, the first one innermost). `context` carries `args`, `parameters`, `globals.theme`, `viewMode: 'story'` and `papercraft` (`theme`, `root` and `portalContainer`, which stays `undefined`). Actions are not synthesized. A plain component also receives the harness's decorators.
- **CSS.** The base of the sheet is a generic theme — Tailwind's variables, preflight and utilities, with a neutral set of shadcn tokens in light and dark —, which belongs to no application, not even to Doric; the surface does not copy the app's theme into the preview, and only the reader's light or dark mode reaches the `mount`. The CSS that the harness imports is the Project's global one and replaces the generic theme: compiled with Tailwind v4, read through `files/v1` (`tailwindcss` comes from the host). The sheet is linked in the frame's document, so the rules apply as written: `:root` is the frame's `<html>`, which carries `class="dark"` in dark mode. The CSS that the components import is appended. Tailwind v3 (`@tailwind`) or a sheet that does not compile falls back to the generic theme, with a warning; `@plugin`/`@config` in JS are ignored with a warning.
- **Portals.** Portaled overlays land in the frame's `document.body`, the default of Base UI and of Radix, and stay inside the preview, because the document is the preview's. The `mount` does not create a portal container, and `context.papercraft.portalContainer` stays `undefined`: a harness that still passes it to a `Portal`'s `container` or to a provider leaves the overlays in the body. Doric's harnesses do not pass it. Revisions published before the frame bring their own `mount`, with the portal container inside the root, and mount in the frame without change.

## Anchors the agent understands

A loose comment ("esse botão está errado") forces the agent to guess which element the user means. The source stamp solves that, and it is the cheapest piece to copy from Glide: the preview's build annotates each element with the file and the line it came from, and the comment's anchor keeps that pair plus the selector.

```xml
<comments>
<target kind="artifact" id="checkout-1" revision="3" title="Checkout" source="src/components/Checkout.tsx">
<comment id="comment-…" pin="1" anchor="src/components/Checkout.tsx:42" element="button">o botão primário some no tema escuro</comment>
<comment id="comment-…" pin="2" anchor="src/components/Checkout.tsx:57" element="div">aqui deveria ter 8px de respiro</comment>
</target>
</comments>
```

When the preview is new `html`, the stamp points to the payload's own file; when it is `component`, it points to the Project's real code — which makes the comment count as an editing instruction, and not as a description. It is this block that `chat` assembles from the stack's lines ([comments](../comments.md#the-prompt-the-xml-envelope)): the note of each line becomes a `<comment>` with its anchor, grouped by the `<target>` (the revision the user saw).

## Comments: two records, one owner

The request says that all comments are attributed to the conversation's context and that the agent acts on them. In the current architecture that is two records, because the durable log and the provider's history are separate contracts — and both are born from the same gesture, the send:

1. **The event** `comments.added/v1` ([comments](../comments.md)) — durable, replayable, drawn as a pin on the canvas and present in the transcript (with the prompt, above the text the user wrote, when the user sent it). It is the comment's memory.
2. **The prompt** — the only channel that wakes the agent, sent through `runtime.threads/v1.prompt({ id, prompt })`, the same path as the conversation's composer (`bundles/desktop/chat/src/client/api/threads-api.ts:32`), in an XML envelope (`<comments>` and `<message>`), a narrow exception to the repository's prompt rules: the content inside is still readable text.

The comment is a draft in the stack above the prompt and the send does the **flush**: it writes the event and sends the prompt with the comments and the anchors (see [Comments above the prompt, draft in the host](#comments-above-the-prompt-draft-in-the-host)). A comment that is never sent does not become an event — the draft is the host's, not the log's.

The `Comentar` control of the header and that of the window's bar are, therefore, a **prompt composer with spatial context**: the comment is confirmed on the canvas, enters the stack above the user's input as a draft and goes out with the next send — or right away, with `Cmd/Ctrl+Enter`.

## Implementation and write-back

Doric is **YOLO by default**: the preview is **not** a gate. The agent publishes the preview and implements the change in the Project's code with the normal tools, in the same turn or in the next — the preview is the window the user looks at, and the comment is what corrects the course ([artifacts](../artifacts.md#the-review-policy)).

What the preview guarantees is **not writing blind**: the tool writes only inside the artifact's directory, and the path guard is the sandbox's own, which refuses any path that resolves outside the workspace root (`docs/features/cwd-tool.md`). The real implementation is another action, on other files, which the preview shows.

Under the `request` policy — the Project's choice, not the default — the wait exists, and it has a place in each home: in the node it is a request in the conversation (the block has no button) and in the window it is the bar's `Autorizar` button (`papercraft.approve/v1`), dispatched through `commands/v1.execute`, the same path that `git`'s Changes panel uses; the approval writes `artifacts.approved/v1` ([artifacts](../artifacts.md)) and sends the prompt that releases the implementation, with the authorized scope. If a button on the node's own block ever makes sense, the renderer adds actions through `chat.hooks/v1.onBeforeRenderBlockHook` and the `IntentDispatcher` turns them into commands.

Write-back by the host — Glide's codemod — remains an **optional** step, and it inherits its two lessons: edits in **staging** before writing and **conflict resolution by property**. Here the staging already exists by construction (the working copy in `.doric/` is separate from the Project's code) and the conflict by property is what the event log gives for free, with one event per adjustment. Today the implementation is the agent editing the files with the normal tools, and that is what the preview shows.

## The `papercraft` bundle

`bundles/features/papercraft` and `bundles/features/artifacts` ([artifacts](../artifacts.md)), in the `enabled` list of `app/backend/doric-host/composition.json`, plus `papercraft-relay` in `resident` if path C is used.

### Durable events

Declared in `contracts/` with `defineEvent` and registered with `events/v1` on activation; the `runtime`'s sink already uses `scopeKeys` `['projectId', 'threadId', 'promptId']` in the stream `runtime.thread.events/{threadId}` (`bundles/runtime/runtime/src/contracts/events.ts:28-32`). The events are those of the [artifact registry](../artifacts.md#lifecycle-and-events), with `kind: 'preview'`; the `source` says where the payload came from.

| Event                   | Payload (summary)                                                                |
| ----------------------- | -------------------------------------------------------------------------------- |
| `artifacts.created/v1`  | `artifactId`, `revision`, `kind`, `title`, `targets`, `path`, `source`, `entry?` |
| `artifacts.revised/v1`  | `artifactId`, `revision`, `changeNote`                                           |
| `artifacts.approved/v1` | `artifactId`, `revision`, `scope` — only under the `request` policy              |
| `artifacts.applied/v1`  | `artifactId`, `revision`, `files`                                                |

The comment is not an event of the artifact: it is `comments.added/v1` ([comments](../comments.md)), with the revision as its target. The comment only enters the log on the send's flush (and the agent's reply, when `comment_reply` runs); while it is a draft, it lives in the composer's stack — host state, not log state.

### Agent tool

A host tool registered in `ToolsV1` with an explicit global position, like the others (`bundles/features/files/src/host/index.ts`). The kind owns its tool ([artifacts](../artifacts.md#the-agents-tool)). It accepts **code and paths**, never a structural description of the interface:

```ts
// papercraft, host/tools/preview.ts — pseudocódigo da API proposta
export const previewTool = defineTool({
  name: 'papercraft_preview',
  description:
    'Publishes a visual preview of a change as a node of the conversation, from real code: an HTML file, a component file in the Project, or the path of an existing component. It writes only inside the artifact directory and never implements the change.',
  input: z
    .object({
      artifact_id: z.string().optional(), // ausente: cria; presente: nova revisão
      title: z.string(),
      source: z.enum(['html', 'component', 'site']),
      path: z.string(), // o arquivo do payload, ou o entry do componente
      files: z
        .array(z.object({ path: z.string(), content: z.string() }).strict())
        .optional(), // o que o agente escreve agora, quando escreve ele mesmo
      notes: z.string().optional(),
    })
    .strict(),
  output: previewStateSchema, // artifactId, revision, path, comments
  execute: async (input, call, services) => {
    // 1. escreve os arquivos em `/workspace/.doric/artifacts/<artifactId>/`, com guarda de caminho
    // 2. materializa o tipo pelo serviço do host (esbuild + markup + CSS)
    // 3. events/v1.append(artifactsCreatedEvent | artifactsRevisedEvent, payload, call)
    // 4. devolve o estado resolvido do preview para o modelo
  },
});
```

The tool's output is the **preview state**, not the confirmation of the write: the model needs to know the current revision and the pending comments with their anchor. The tool also reads the comments from the log in the call's scope, so that the round of adjustments does not depend on the user repeating the text in the prompt: it returns the **unresolved roots** of each thread, each with its `replies` (the replies, in order; the last one can be the user's answer to a question from the agent).

### Agent skill

What teaches **when** to propose a preview and **why** it exists is not the tool's body: a tool is a contract, and the judgment of when to use it is a skill — the same split that `web` makes between the tool and `web-research`. It lives in `bundles/features/papercraft/src/skills/papercraft-preview/SKILL.md` and is discovered like the others (`packages/bundle/src/loader/skills.ts`):

```yaml
---
name: papercraft-preview
description: 'Publishes a visual change as a live preview node of the conversation, built from real code, instead of describing it. Use when the change is easier to judge by looking than by reading a diff, and the user should see it, comment on it and steer it.'
allowed-tools:
  - papercraft_preview
  - comment_reply
  - write
  - edit
order: 3400
---
```

The body answers the three questions that the tool's signature does not answer:

- **why**: a visual change is judged by looking, not by reading a diff; the preview is cheaper to change than an implementation; and it is what lets the user **see what is being done**, instead of finding out later;
- **when to use**: a change that is visual, a user who has not decided yet, an explicit request to see/mock/prototype, or an adjustment of a preview that already exists — which is a **revision** of the same preview, and not a new preview;
- **when not to use**: a change that is not visual, inspection of the running app, and an artifact that would need code the agent cannot write — say what is missing instead of previewing something else.

The procedure fixes the decisions the agent would get wrong on its own: choosing the preview's source by what the change touches (`component` for real code, because the stamp makes the comment count as an editing instruction; `html` for a new idea; `site` only when the server is the point), writing the payload inside the artifact's directory, reading the state the tool returns (revision and pending comments with their anchor), **implementing the change** with the normal tools — the preview is not a gate, Doric goes straight on — treating each comment as the request of the next revision and **answering it with `comment_reply`** — saying what changed or asking what it did not understand — with `resolve` when it is addressed. Only under the Project's `request` policy does the agent wait for `artifacts.approved/v1`.

`allowed-tools` lists the four tools the procedure names: the bundle's tool, the `comment_reply` of `comments` and the two write utilities of `files`. The registry resolves them against the catalog seen by the generation (`D10-6`), so a Project without `files` refuses the skill with `unavailable_tool`, instead of failing in the middle of the flow. `order: 3400` is the next free band after the skills of `threads` (3300), in the same scheme of bands of 100 as `files` (100–1300) and `git` (2100–2600).

### Host service

The registry, the revisions and the authorization belong to the `artifacts/v1` service ([artifacts](../artifacts.md#the-artifactsv1-contract)); the comments belong to `comments/v1` ([comments](../comments.md)); and what belongs to the `preview` kind is in `papercraft.previews/v1`: `build({ path })` compiles and stamps the payload and returns `{ path, sha256 }` of each entry (what the durable event references) — it is the materialization the registry calls —; `read({ artifactId, revision })` returns A's fallback markup+CSS and what the canvas needs from the preview. Services called by a window declare `desktopScope` with `['projectId', 'threadId', 'promptId']` and methods with `expose: 'desktop'`, like `resources/v1` and `screen.views/v1`. The registry reads and writes `.doric/` through the lease, as `files` does; without a lease it answers with state, like `files/v1`.

### Conversation node

The `client` part registers, with `whenAvailable(ChatViewsV1, …)` as `threads` does (`bundles/features/threads/src/client/index.ts:23-27`): a projector that produces one block per revision (`papercraft.preview/v1`, the kind's `blockType` — [artifacts](../artifacts.md#the-node)) and a `papercraft-preview` renderer. The element receives the block through the `block` property and the chat hands it each newer version (`chat-block-node.tsx:83-87`); it mounts the revision's module in the preview's isolated frame (above, [The UI in the node and in the window](#the-ui-in-the-node-and-in-the-window)) and draws the canvas chrome.

### Canvas window

Decided: the window is an **app route** (`/papercraft/:artifactId`), opened and focused by `windows/v1` with a stable key per preview (prefixed by the core with the `bundleId`); the surface is the same as the node's, full screen, with the overlay header (macOS traffic lights + file name), the tree on the left and the command bar at the bottom center — no footer. The detail is in [The UI in the node and in the window](#the-ui-in-the-node-and-in-the-window). The host's `view` window, with its own `partition`, is left for `site` and third-party content.

## User flow, step by step

| Step | The user does                     | What happens                                                                                                                                   |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | "corrige o componente X"          | An ordinary prompt. No papercraft yet.                                                                                                         |
| 2    | —                                 | The agent reads the component index, writes the payload and calls `papercraft_preview`; the event enters the log and the node appears.         |
| 3    | —                                 | The agent implements the change in the Project's code — the preview is **not** a gate.                                                         |
| 4    | Asks for adjustments X, Y and Z   | In the node or in the window: each comment becomes a line in the stack above the prompt; the send does the flush (event + prompt).             |
| 5    | —                                 | New revision: the same `artifact_id`, a new event, **a new node**. The old node remains, with its comments.                                    |
| 5b   | —                                 | The agent answers each comment with `comment_reply` (and resolves the addressed one); the pin changes state and the reply appears in the turn. |
| 6    | Authorizes (only under `request`) | `papercraft.approve/v1` → `artifacts.approved/v1` + prompt, and the agent implements.                                                          |

Step 5 is the strongest requirement of the request: one block per revision keeps the old preview in the conversation and open to comments, with no extra state, because the replay rebuilds all the blocks of the log in sequence order.

## Replay and rewind

The projectors of `chat.views/v1` are pure and run from the initial state over the whole list of events, on replay and on rewind (`bundles/desktop/chat/src/client/domain/external-blocks.ts:41-98`). Consequences:

- the canvas of a node is rebuilt from the events, never from stored local state;
- a rewind to before a preview removes the node, because the event leaves the log;
- effects that must not repeat (compiling, stamping, starting a server) live in the host, and the replay does not re-run them;
- the canvas's derived tree is recomputed on every render, and none of it is persisted.

## Open decisions

1. **Decided: B in the node.** The artifact compiles to an ESM module, is served by the app's origin (`/artifacts/…`) and the runtime of the preview's frame imports and mounts it, in a sandboxed iframe of opaque origin ([isolation](isolamento.md)); A remains as the static fallback. The Project's code does not receive the app's trust: it does not reach the app's bridge, DOM, globals or storage.
2. **Decided: bundling runs in the sandbox, Tailwind in the host.** esbuild comes from the sandbox image (`.sandbox.Dockerfile`, at the host's version) and the runner comes from the host, so the resolution is the same on both sides; reading each file through `files/v1` cost round trips to the sandbox for each file and imposed a budget of 1,500 reads and the limit of 256 KB per file. Without esbuild in the image, the host bundles as before.
3. **`site` preview with a dev server.** Depends on `ports` existing (`docs/architecture/bundles/port-forwarding.md`).
4. **Decided: the directory is `/workspace/.doric/artifacts/<artifactId>/` and it starts ignored by Git** ([artifacts](../artifacts.md#open-decisions)). The preview is an artifact of the `preview` kind, and visibility became the registry's: versioning an artifact is the user's choice.
5. **Relation to write-back.** The codemod in the host (Glide's model) or the agent itself editing the files. The second option already works today.
6. **Source stamp in third-party components.** What to do when the stamped line changes between revisions.
7. **Comment with a prompt in progress.** The queue of `runtime.threads/v1` accepts it; it remains to decide whether the stack enqueues or waits.
8. **Under `request`, the semantics of approval.** What counts as approval and whether an authorized revision can be replaced later. Doric's default is not to need this (decision 3 of [artifacts](../artifacts.md#open-decisions)).
9. **Position of the tool** in the model's global catalog, which today goes from 100 to 900 (`D10-5`); the `papercraft-preview` skill is already at `3400`, the next free band after the skills of `threads`.
10. **Cache key and fallback of the preview.** Including `PLATFORM_VERSION` in the key, and deciding whether A's markup remains the mandatory fallback of every revision with a script.
11. **Decided: the window is an app route.** `windows/v1` opens `/papercraft/:artifactId` (path window, without `partition`), instead of the `view` window with a host page; that one is reserved for `site` and third-party content (path C). Inside the window, the preview runs in the same isolated frame as in the node.
12. **Decided: when authorization exists, it lives in the window's bar.** The request in the conversation still exists — the node has no button — and the window gains the bar's `Autorizar` button ([above](#the-command-bar)), which becomes the `Autorizado` readout when the revision has already been approved. It only appears under the `request` policy, and its semantics (decision 8) and whether it also fits in the comment's popover remain open.
13. **Decided: the revision has a readout in the bar.** The node shows the revision it was created with and the window opens on the newest; the bar's `rev 1/2` readout ([above](#the-command-bar)) switches the revision on screen when there is more than one.
14. **Where the draft lives.** The draft (the prompt's text and the stack of comments) stays in the host, in `chat.composer/v1`, to survive navigation and hold for every window; it remains to decide whether it outlives the process — a record in the cache, as `history` does, to survive the app being closed — and whether the editor's text syncs on every keystroke or in short batches.
15. **One channel for every window.** Today the draft lives in the `threadChatsStore` of the window that wrote it; the host service becomes the owner, and it remains to decide what a window does when the prompt is sent in another (the stack empties for all of them, and the editor of the others is cleared).
16. **The artifact registry.** The preview becomes a kind of the registry ([artifacts](../artifacts.md)); left open there are the shape of `artifactId`, the review policy and what happens when the stamp's target changes between revisions.
17. **Decided: the preview is not a gate.** Doric is YOLO by default: the agent publishes and goes straight on, the comment corrects the course and authorization is the exception, by the Project's policy ([artifacts](../artifacts.md#the-review-policy)). Decision 8 then becomes a question about the `request` case.
18. **Decided: the resolution.** A comment is resolved per thread: by the user, in the pin's popover, or by the agent, with `resolve` in `comment_reply`; the pin shows the state (`done`, `await`, `open`) and resolved threads can be hidden. This closes item 5 of the open decisions of [comments](../comments.md#open-decisions).
19. **Known limitation: the canvas window and the open event.** `doric:comment-thread-open` is a DOM event of `chat`; the canvas window is another document and does not receive it, so only the node opens the thread from the conversation.
20. **States side by side.** The proposal is designed ([above](#states-side-by-side-proposal)). It remains to decide which stories go in when the tool lists none, the limit of frames per preview and what happens to a frame that disappears in a revision.

## Composition and parts

- `host` — the `papercraft_preview` tool, the registry's `preview` kind (`artifact.kind/v1`) and `papercraft.previews/v1`; `requires` `tools/v1`, `events/v1`, `files/v1`, `runtime.threads/v1`, `artifacts/v1` and `comments/v1` — the registry and the comments belong to other bundles, and papercraft only contributes the kind.
- `client` — projector, renderer, the `/papercraft/:artifactId` route and the two elements (`<papercraft-preview>`, `<papercraft-canvas>`) over the shared surface; `requires` `ui/v1`, `navigation/v1`, `commands/v1`, `menus/v1`, `hooks/v1` and the host contracts `papercraft.previews/v1` — it is through it that the bar's commands read the preview —, `artifacts/v1` and `comments/v1` — it is through them that they read the revision and write the comment —, and consults `chat.views/v1`, `chat.hooks/v1` and the proposed host service `chat.composer/v1` through `whenAvailable`.
- `desktop` — registers `papercraft.open-canvas/v1` and opens or focuses the route's window through `doric.windows/v1`, with the key prefixed by the core.
- `papercraft-relay` (resident) — only when path C exists (`site`, third parties): serves `/papercraft/<token>/` on the host's origin, mirroring `screen-relay`.
- `skills/papercraft-preview/` — the `papercraft-preview` skill ([above](#agent-skill)), which is the judgment of when to propose a preview and the flow of publishing, implementing and revising, on the model of `web` with `web-research` (`bundles/features/web/src/skills/web-research/SKILL.md`).

## Delivery stages

The artifact registry ([artifacts](../artifacts.md#delivery-stages)) is a prerequisite of stage 1; the stages below are papercraft's.

1. **Live preview with events.** The tool and the `papercraft-preview` skill that teaches when to use it, the `preview` kind in the registry, build/render in the host, the `/artifacts/` route in the handler, the projector, the renderer and the node mounting the module (path B, with A's markup as the fallback; today in the isolated frame, see [isolation](isolamento.md)).
2. **Canvas.** Pan, zoom, selection, derived tree and layers, all local.
3. **Anchored comments.** Source stamp, pins, the stack of cards above the prompt and the send's flush, with the draft in the host service of `chat`.
4. **Canvas window.** The `/papercraft/:artifactId` route, the `papercraft.open-canvas/v1` command, the window through `windows/v1` with the overlay header (traffic lights + file name), the tree on the left and the command bar at the bottom center, with the four groups and the shortcuts of `menus/v1`; a second click focuses the window already open for the preview.
5. **`request` policy.** The request in the conversation, the bar's `Autorizar` button and `artifacts.approved/v1`, as an opt-in exception of a Project.
6. **Accumulated revisions.** Adjustments as `artifacts.revised/v1`, with the old node preserved, as the flow requires.
7. **Write-back by the host.** The optional codemod (Glide's model); today the implementation is the agent's, and the preview already shows it. `site` and third-party content get the `view` window (path C) when `ports` exists.
8. **Frames.** States side by side from a stories file, with the theme as a dimension, the floating structure with the frames at the first level, the `N estados` menu in the bar and the `frame` key in the anchor; then, frames from different files.

## Mockups

Static HTML pages, to open directly in the browser. They record the design decisions; the code remains the source of the behavior.

- [Comments and threads](./mockups/comments.html): the pin with states, the hover label, the thread popover and the stack above the prompt. The first comment's field appears without a surface, as it was designed; in the code it got the popover's surface back.
- [Replies in the chat](./mockups/replies.html): the layout options for the agent's replies. The chosen one is C, the collapsed tool line, and the user's turn no longer shows the state chip.
- [States side by side](./mockups/states.html): the frames proposal, in the window and in the node ([above](#states-side-by-side-proposal)).

## References

- [Glide](https://github.com/SrivarsanK/Glide): canvas, scene graph, source stamp, staging and write-back.
- The bottom toolbar of canvas editors (Figma, Paper): the design reference of the command bar — grouped icons, the readouts in the middle and the primary action on the right.
- [Artifacts](../artifacts.md): the registry that gives identity, revisions, anchors and review state to the agent's deliverables, and the `preview` kind.
- [Comments](../comments.md): the concept's spec — the target, the anchor, the two records and the draft in the host.
- [Events and nodes](../events-and-nodes.md): why the durable log is not the provider's history.
- [The chat bundle](../chat.md): projectors, renderers and the complete example of `git`.
- [UI composed by bundles](../ui-composition.md) and [React inside Web Components](../react-web-components.md): how a node element is defined and hosted.
- [Shared packages and theme tokens](../platform-packages.md): import map, theme and the Tailwind rule.
- [`doric://` protocol](../doric-protocol.md): the single origin, the per-request shell and the CSP.
- [Windows opened by the core](../windows.md): `windows/v1`, paths and partitions.
- [Port forwarding](../port-forwarding.md): the `screen`/`screen-relay` precedent of serving sandbox content in a window.
