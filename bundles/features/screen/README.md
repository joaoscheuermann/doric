# Screen bundle

`screen` gives every Project's sandbox a graphical screen the reader can watch
and drive. It starts an xpra server with its HTML5 client inside the sandbox,
publishes it on the host's own origin through the
[`screen-relay`](../screen-relay/README.md) bundle, keeps the reader's screen
views, opens one desktop window per view, and draws the sidebar's **Screens**
pane. A GUI program started on the session's X display, by the reader or by the
agent, draws there.

Feature docs: [Screen](../../../docs/features/screen.md) (the flow from the
pane to the live screen, and the feature's decisions),
[Projects and Threads](../../../docs/features/projects-and-threads.md) (how a
bundle reaches a Project's sandbox through `runtime.lease/v1.withLease`) and
[UI redesign](../../../docs/features/ui-redesign.md) (the sidebar's panes).
See [`packages/bundle`](../../../packages/bundle/README.md) for how bundles are
built and loaded.

## Manifest

[`manifest.json`](manifest.json):

| Field          | Value                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `screen`, version `2.0.4`, engine `doric ^1.0.0`                                                                                                                             |
| `description`  | The xpra HTML5 screen of a Project's sandbox.                                                                                                                                |
| `provides`     | `screen.sessions/v2@2.0.0` (host part), `screen.views/v1@1.0.0` (desktop part)                                                                                               |
| `requires`     | `log/v1@^1.0.0`, `runtime.lease/v1@^1.1.0`, `ui/v1@^1.0.0`, `workspace.selection/v1@^1.0.0`, `runtime.records/v1@^1.0.0`, `layout.stack/v2@^2.0.0`, `screen.relay/v1@^1.0.0` |
| `optional`     | none                                                                                                                                                                         |
| `desktopScope` | `projectId`, `threadId` and `promptId`: the scope keys a window may send with a call of `screen.sessions/v2`                                                                 |

Every entry of `requires` is required: a composition missing any of them
quarantines the bundle. The package exports `screen/contracts` and `screen/package.json`
([`package.json`](package.json), [`src/contracts/index.ts`](src/contracts/index.ts)).

## Parts

| Part        | Entry                                              | What it does                                                                                                                                                                   |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contracts` | [`src/contracts/index.ts`](src/contracts/index.ts) | Declares both contracts, their types and their zod schemas.                                                                                                                    |
| host        | [`src/host/index.ts`](src/host/index.ts)           | Provides `screen.sessions/v2`: ensures the xpra session in a Project's sandbox and publishes it on `screen.relay/v1`.                                                          |
| desktop     | [`src/desktop/index.ts`](src/desktop/index.ts)     | Provides `screen.views/v1`: owns the reader's views, their cache file, the dial loop and the screen windows.                                                                   |
| client      | [`src/client/index.ts`](src/client/index.ts)       | Registers the Screens pane in `layout.stack/v2`, defines `<screen-sidebar>` and `<screen-group-action>`, mirrors the views and makes the host calls the desktop part asks for. |

The desktop part cannot call a host contract: a desktop generation reaches only
the providers of its own environment and the platform's `doric.*` services. So
the desktop part lists each attach it wants as a _dial_ in its `watch` stream,
the client part of an app window makes the call, and hands the answer back
through `deliver` ([`src/desktop/views.ts`](src/desktop/views.ts),
[`src/client/index.ts`](src/client/index.ts)).

## Contract `screen.sessions/v2` (host)

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as
`ScreenSessionsV2`; provided with `expose: 'desktop'`, so app windows call it
over the host bridge ([`src/host/provider.ts`](src/host/provider.ts)).

```ts
type ScreenUnavailableReason = 'sandbox' | 'missing-xpra' | 'start-failed';

type ScreenAttach =
  | { status: 'ready'; path: string; display: string } // path starts with '/'
  | { status: 'pending' }
  | { status: 'unavailable'; reason: ScreenUnavailableReason };

interface ScreenSessions {
  attach(projectId: string, call?: CallArg): Promise<ScreenAttach>;
}
```

The input is a string; the output is validated by `screenAttachSchema`, a
strict discriminated union on `status`.

| Answer                        | Meaning                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ready`                       | `path` is `/screen/<token>/`, relative to the host's origin; `display` is the X display, e.g. `:100`. |
| `pending`                     | The lease of the call's scope is still coming up.                                                     |
| `unavailable`, `sandbox`      | The lease is in any other state that is not ready (unavailable, expired, missing).                    |
| `unavailable`, `missing-xpra` | `command -v xpra` fails in the sandbox.                                                               |
| `unavailable`, `start-failed` | The session could not be started, or the sandbox has no routable address.                             |

`attach` resolves `runtime.lease/v1` for the call's scope (`call.scope`, which
the window sets to `{ projectId }`), and the `projectId` argument keys the
Project's session and its in-flight attempt ([`src/host/provider.ts`](src/host/provider.ts),
[`src/client/index.ts`](src/client/index.ts)).

## Contract `screen.views/v1` (desktop)

Declared in [`src/contracts/index.ts`](src/contracts/index.ts) as
`ScreenViewsV1`; every method has `expose: 'desktop'` in `screenViewsMethods`
([`src/contracts/index.ts`](src/contracts/index.ts)), and the desktop part
provides it ([`src/desktop/index.ts`](src/desktop/index.ts)).

```ts
type ScreenViewStatus =
  | { kind: 'waiting' }
  | { kind: 'ready'; path: string; display: string } // path starts with '/'
  | { kind: 'unavailable'; reason: ScreenUnavailableReason }
  | { kind: 'failed' };

interface ScreenView {
  id: string; // non-empty
  label: string; // non-empty
  projectId: string; // non-empty
  status: ScreenViewStatus;
}

interface ScreenAttachRequest {
  viewId: string; // non-empty
  projectId: string; // non-empty
  seq: number; // positive integer
}
interface ScreenAttachReport {
  viewId: string; // non-empty
  seq: number; // positive integer
  answer: ScreenAttach | null;
}
interface ScreenViewsState {
  revision: number; // positive integer
  views: readonly ScreenView[];
  dials: readonly ScreenAttachRequest[];
}

interface ScreenViews {
  list(call?): Promise<readonly ScreenView[]>;
  // projectId non-empty; label, when given, non-empty
  add(input: { projectId: string; label?: string }, call?): Promise<ScreenView>;
  remove(viewId: string, call?): Promise<void>; // viewId non-empty
  open(viewId: string, call?): Promise<void>; // viewId non-empty
  retry(viewId: string, call?): Promise<void>; // viewId non-empty
  deliver(report: ScreenAttachReport, call?): Promise<void>;
  watch(
    revision: number,
    listener: StreamListener<ScreenViewsState>,
    call?,
  ): Disposable;
}
```

Every object schema is strict. `watch` takes the tuple
`[revision (non-negative integer), streamListener]`; the listener is the last
item, which makes it a stream across the desktop bridge.

| Method    | Behavior                                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`    | The views in insertion order.                                                                                                                                                                                                                                                                                                                             |
| `add`     | When a view already watches `projectId`, answers that view and opens or focuses its window (at once when it is ready, otherwise once it is, never for a view that is `unavailable` with `missing-xpra`). Otherwise creates a `waiting` view with a random UUID, labelled `label` or else `projectId`, stores the list and answers it; it opens no window. |
| `remove`  | Drops the view from the list and the file. An unknown id does nothing. The view's window stays open.                                                                                                                                                                                                                                                      |
| `open`    | For a ready view, opens its window or focuses it. For a view that is not ready, remembers the request and makes the view due: the loop dials it on its next pass unless a dial is already in flight, and the window opens when the view becomes ready. A view that is `unavailable` with `missing-xpra` is never dialed, so its window never opens.       |
| `retry`   | For a ready view, applies the window decision with focus but without asking for a window: it focuses an open window, reopens one the focus finds closed, navigates one on another path, and does nothing when no window was opened. Otherwise drops any dial in flight and makes the view due.                                                            |
| `deliver` | Applies the answer only when `seq` is the view's current dial; otherwise ignores it. Sets the status, applies the window decision, then announces the change.                                                                                                                                                                                             |
| `watch`   | Pushes the state once the views are loaded, unless the caller already holds that revision, and after every change. The state starts at revision 1, so `watch(0, …)` always receives a first push.                                                                                                                                                         |

Implemented in [`src/desktop/views.ts`](src/desktop/views.ts) and
[`src/desktop/status.ts`](src/desktop/status.ts).

## Contracts used

| Contract                 | Part    | What for                                                                                                                                                       |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.lease/v1`       | host    | `withLease(task, call)` runs the session work on the sandbox the call's Project holds now; it never acquires one ([runtime](../../runtime/runtime/README.md)). |
| `screen.relay/v1`        | host    | `expose({ token, host, port })` publishes a session's upstream; `forget({ token })` drops it ([screen-relay](../screen-relay/README.md)).                      |
| `log/v1`                 | host    | Warnings of an unavailable session, a taken port and an unwritten marker.                                                                                      |
| `doric.cache/v1`         | desktop | `directory(call)`: the directory of `views.json`.                                                                                                              |
| `doric.windows/v1`       | desktop | `open`, `focus` and `navigate` of the screen windows ([windows](../../../docs/architecture/bundles/windows.md)).                                               |
| `ui/v1`                  | client  | Defines `<screen-sidebar>` and `<screen-group-action>`.                                                                                                        |
| `layout.stack/v2`        | client  | `register(pane)` puts the Screens pane in the sidebar's stack ([layout](../../desktop/layout/README.md)).                                                      |
| `workspace.selection/v1` | client  | `current().projectId` and `subscribe`: the selected Project.                                                                                                   |
| `runtime.records/v1`     | client  | `project(id)?.name` and `subscribe`: the label of a new view.                                                                                                  |
| `screen.sessions/v2`     | client  | The dial's host call, resolved with the scope `{ projectId }`.                                                                                                 |
| `screen.views/v1`        | client  | The pane's commands and the `watch` stream.                                                                                                                    |

The client part declares narrowed copies of `workspace.selection/v1` and
`layout.stack/v2` in [`src/client/peers.ts`](src/client/peers.ts) instead of
importing their packages; `runtime.records/v1` and `runtime.lease/v1` come from
`runtime/contracts`, `screen.relay/v1` from `screen-relay/contracts`.

## Sessions on the host

[`src/host/provider.ts`](src/host/provider.ts) and
[`src/host/session.ts`](src/host/session.ts).

- **One attempt per Project.** Concurrent `attach` calls with the same
  `projectId` share one promise until it settles.
- **Lease.** The work runs inside `withLease`; a `pending` outcome answers
  `pending`, any other outcome that is not `ready` answers `unavailable` with
  `sandbox`.
- **Ensure, in the sandbox** (every command through `sandbox.exec`):
  1. `sh -c 'command -v xpra'` (10 s); a non-zero exit throws `missing-xpra`.
  2. Read the marker `/tmp/doric-screen.json`, list live displays with
     `xpra list` (lines `LIVE session at :<n>`), and find the sandbox's address
     as the first IPv4 address of `hostname -I` not in `127.*` (cached per
     sandbox id; none throws `start-failed`).
  3. Reuse: a marker whose display is live and whose port accepts a TCP
     connection within 1 s is answered as it is.
  4. A marker whose display is live but whose port does not answer has the
     display stopped with `xpra stop :<display>` (failure ignored).
  5. Start on the marker's display, or else the lowest display from 100 up that
     `xpra list` does not report. Try the ports 14500, 14501, 14502 in order,
     the marker's port first, each with
     `xpra start :<display> --html=on --bind-tcp=0.0.0.0:<port> --daemon=yes --log-file=/tmp/doric-screen.log`
     (30 s). A start succeeds when `xpra list` reports the display live within
     10 s and then the port accepts a connection within 10 s (polled every
     250 ms). A failed start moves to the next port, logging
     `Screen port is taken`, only when the last 4,096 characters of the log
     contain `Address already in use` or `failed to setup tcp socket`; any other
     failure, or a failure on the last port, throws `start-failed`.
  6. Keep the marker's token or create a random UUID, and write the marker
     `{ display, port, token }`. A failed write logs
     `The screen marker could not be written` and the session is still served.
- **Control files.** The marker and the log live in the sandbox's `/tmp`,
  which `sandbox.readFile` and `sandbox.writeFile` refuse, so they are read
  with `cat` and written with `sh -c 'printf %s "$1" > "$2"'`, the content
  passed as an argument. An unreadable or invalid marker (not an object, a
  display or port that is not a positive integer, a port above 65,535, an empty
  token) reads as none.
- **Publish.** When the Project's previous token differs from the session's,
  `forget` drops it first; then `expose({ token, host, port })`, and only then
  `attach` answers `{ status: 'ready', path: '/screen/<token>/', display: ':<n>' }`.
  The path is relative: the app resolves it against the origin it reaches the
  host on, which the relay serves.
- **Deactivation.** The host part forgets every token it published, ignoring a
  relay that fails or is gone; a generation that published none touches no
  relay ([`src/host/index.ts`](src/host/index.ts)).

## Views, dials and windows on the desktop

[`src/desktop/views.ts`](src/desktop/views.ts),
[`src/desktop/status.ts`](src/desktop/status.ts),
[`src/desktop/windows.ts`](src/desktop/windows.ts),
[`src/desktop/store.ts`](src/desktop/store.ts).

- **Loading.** Activation builds the owner but reads nothing: the views file is
  read on the first call of any method, because the build also runs
  `activate` against recording services that answer nothing
  ([`record.ts`](../../../packages/bundle/src/build/record.ts)). A loaded view
  starts `waiting`.
- **Status of an answer.** `ready` → `ready` with `path` and `display`;
  `pending` → `waiting`; `unavailable` → `unavailable` with its reason; `null`
  (no answer) → `failed`.
- **Dial loop.** Every second the owner looks at each view. A dial unanswered
  for more than 5 s is dropped. A view with no dial in flight whose next dial is
  due gets a new dial with the next sequence number (one counter across all
  views), and its next dial is set:

  | Status                                                         | Next dial after |
  | -------------------------------------------------------------- | --------------- |
  | `waiting`, `failed`, `unavailable` (`sandbox`, `start-failed`) | 2 s             |
  | `ready` with an open window                                    | 15 s            |
  | `ready` with no window                                         | never           |
  | `unavailable`, `missing-xpra`                                  | never           |

  The loop starts on the first `list`, `add`, `open` or `retry`, not on `watch`
  or `deliver`. Each new or dropped dial announces a change.

- **Window decision** for a view, after a `deliver` (no focus) and on `add`,
  `open` and `retry` of a ready view (focus): a view that is not ready does
  nothing; with no window yet, it opens one when the reader asked for it; with a
  window opened on another path, it navigates the window to the new path; with
  a window on this path, it focuses it when asked to. When a focus finds no
  window with that key, the window is opened again. After an open or a navigate,
  the request is cleared.
- **The window.** `doric.windows/v1.open` with key `screen:<viewId>`, a view of
  the path in the session partition `screen:<viewId>`, the view's label as the
  title and the native title bar, with no preload and no app chrome.
  `navigate({ key, path })` re-points it.
- **Revision.** Every change raises the revision by one before the listeners
  are called; a listener that throws reaches no other listener.
- **Deactivation** stops the loop, drops every listener, view and request, and
  forgets the loaded file ([`src/desktop/index.ts`](src/desktop/index.ts)).

## The Screens pane (client)

[`src/client/index.ts`](src/client/index.ts),
[`src/client/elements.tsx`](src/client/elements.tsx),
[`src/client/store.ts`](src/client/store.ts),
[`src/client/api.ts`](src/client/api.ts),
[`src/client/dial.ts`](src/client/dial.ts).

- **Pane.** Whenever `layout.stack/v2` is served, the client part registers
  `{ id: 'screen-sidebar', order: 10, title: 'Screens', tag: 'screen-sidebar', headerTag: 'screen-group-action', collapsible: true, initiallyOpen: false }`.
  The layout draws the group, its header and collapse control, caps the open
  pane at 40% of the column, and shows the header element while the header is
  hovered or focused
  ([`project-sidebar.tsx`](../../desktop/layout/src/client/components/organisms/project-sidebar.tsx),
  [layout](../../desktop/layout/README.md)).
- **Binding.** Whenever `screen.views/v1` is served, the client part calls
  `watch(0, …)`; each push replaces the mirrored views, and each request in
  `dials` is dialed. A dial calls `screen.sessions/v2.attach(projectId)` with
  the scope `{ projectId }` and calls `deliver` with the answer. A Project id
  that is empty, longer than 200 characters or contains NUL, a call that fails,
  and an answer that does not parse as `ScreenAttach` deliver `answer: null`; a
  failing `deliver` is swallowed. Every app window running the client part
  dials, and `deliver` applies only the first answer of a dial.
- **`<screen-group-action>`** (the header's **+**, "New screen view") calls
  `add({ projectId, label })` for the Project selected in
  `workspace.selection/v1`, with the Project's `runtime.records/v1` name as the
  label when the record has one. It is disabled with no selected Project or
  while `screen.views/v1` is not served.
- **`<screen-sidebar>`** lists the views of the selected Project only; with a
  Project selected and none, it shows `No screens open`, and with no Project,
  nothing. Clicking a row calls `open`. A row shows the label and one state;
  over its right edge, on hover or keyboard focus, it shows Remove and, when
  the state allows it, Retry, while the state text fades out. While
  `screen.views/v1` is not served, rows and actions are disabled.

  | Status                        | Row text                 | Retry |
  | ----------------------------- | ------------------------ | ----- |
  | `waiting`                     | `Starting…` (spinner)    | No    |
  | `ready`                       | the display, e.g. `:100` | No    |
  | `unavailable`, `sandbox`      | `Sandbox unavailable`    | Yes   |
  | `unavailable`, `start-failed` | `Screen failed to start` | Yes   |
  | `unavailable`, `missing-xpra` | `No xpra in the image`   | No    |
  | `failed`                      | `Backend unavailable`    | Yes   |

- **Mirror.** The window's store notifies only when a view's id, label,
  Project, status kind, ready path or unavailable reason changes; command
  failures from the pane are swallowed.
- **Styles.** [`src/client/styles.css`](src/client/styles.css) scans no file
  and emits only the classes of one `@source inline(…)` list: the rows'
  hover, pressed and focus states and the actions' reveal. The other classes of
  the elements come from the app window's own sheet. A class added to
  [`src/client/elements.tsx`](src/client/elements.tsx) that the app window's
  sheet does not emit is also added to that list, and to the list that
  [`tests/styles-cascade.test.ts`](tests/styles-cascade.test.ts) checks it
  against, in the same order. A wider sheet would re-emit classes that move
  other bundles' rules in the cascade of a window that loads every bundle
  sheet; the test also fails when the built sheet reaches 8 KiB or re-emits
  `border`, `transition-transform`, `hover:text-foreground` or `inline-flex`.

## Data and persistence

| Data           | Where                                                                                                    | Shape                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Views          | `views.json` in the bundle's `doric.cache/v1` directory ([`src/desktop/store.ts`](src/desktop/store.ts)) | `{ version: 1, views: [{ id, label, projectId }] }`, 2-space JSON |
| Session marker | `/tmp/doric-screen.json` in the sandbox ([`src/host/session.ts`](src/host/session.ts))                   | `{ display, port, token }`                                        |
| xpra log       | `/tmp/doric-screen.log` in the sandbox                                                                   | xpra's own log                                                    |

The views file is written on every `add` of a new view and every `remove`,
through a `.tmp` file that `rename` puts in its place. A missing or unreadable file, a file
that is not this shape, or one with a single invalid entry reads as no views;
a failed write keeps the list in memory. Statuses, dials and window state are
never stored. Every stored view loads, so a file with two views of one Project
shows both ([`src/desktop/views.ts`](src/desktop/views.ts)).

## Side effects

- Starts and stops xpra daemons, and writes the marker, in the Project's
  sandbox ([`src/host/session.ts`](src/host/session.ts)).
- Registers and drops tokens on the relay, which makes the screen reachable at
  `/screen/<token>/` on the host's origin ([`src/host/provider.ts`](src/host/provider.ts)).
- Opens, focuses and navigates native windows
  ([`src/desktop/windows.ts`](src/desktop/windows.ts)).
- Writes `views.json` in its cache directory
  ([`src/desktop/store.ts`](src/desktop/store.ts)).

## Configuration

The bundle has no setting. Its constants are the paths, the display base 100,
the ports 14500–14502 and the timeouts above
([`src/host/session.ts`](src/host/session.ts),
[`src/desktop/status.ts`](src/desktop/status.ts),
[`src/desktop/views.ts`](src/desktop/views.ts)). The sandbox image must
provide `xpra` with its HTML5 client; the host's image
[`app/backend/doric-host/.sandbox.Dockerfile`](../../../app/backend/doric-host/.sandbox.Dockerfile)
installs it, and the composition must run `screen-relay` resident
([`app/backend/doric-host/composition.json`](../../../app/backend/doric-host/composition.json)).

## Limits

- One session per Project: every Thread of a Project shares its sandbox and its
  screen ([`src/host/session.ts`](src/host/session.ts)).
- `add` creates at most one view per Project
  ([`src/desktop/views.ts`](src/desktop/views.ts)).
- The token is the only access control: whoever reaches the host's origin with
  it can watch and drive the screen ([screen-relay](../screen-relay/README.md)).
- After an app restart, loaded views stay `waiting` until the reader adds,
  opens or retries a view, because the window only watches and `watch` does not
  start the loop ([`src/desktop/views.ts`](src/desktop/views.ts),
  [`src/client/index.ts`](src/client/index.ts)).
- The desktop part learns that the reader closed a window only when a focus
  finds it gone; until then a ready view is dialed every 15 s. If its screen
  then moves, `navigate` on the closed key fails, so `deliver` rejects after
  storing the status and before announcing it, and every later answer and row
  click fails the same way until the view is removed and added again or the app
  restarts ([`src/desktop/views.ts`](src/desktop/views.ts),
  [`src/desktop/windows.ts`](src/desktop/windows.ts)).

## Errors and failure behavior

- `attach` reports `ScreenSessionError` as `unavailable` with its reason and
  logs `The screen session is unavailable` with the Project id and reason. Any
  other error (a `sandbox.exec` call that rejects, other than the `cat`, the
  `xpra stop`, the polling `xpra list` and the marker write, whose failures are
  ignored, or a relay that rejects) rejects the call; the window turns it
  into `answer: null`, which shows `Backend unavailable`
  ([`src/host/provider.ts`](src/host/provider.ts),
  [`src/client/api.ts`](src/client/api.ts)).
- The views owner never fails a read because of a view: every failure is a
  status. Cache read and write failures are swallowed; a window call that fails
  rejects the method that made it, and the pane swallows it
  ([`src/desktop/views.ts`](src/desktop/views.ts),
  [`src/client/elements.tsx`](src/client/elements.tsx)).
- A call whose input fails its schema is rejected with `invalid_input` before
  the method runs
  ([`dispatch.ts`](../../../packages/bundle/src/runtime/dispatch.ts)).
- A loop pass that throws does not stop the loop
  ([`src/desktop/views.ts`](src/desktop/views.ts)).

## Build and test

```console
npx nx run bundle-screen:typecheck
npx nx run bundle-screen:test
npx nx run bundle-screen:build
```

`test` builds the bundle first, compiles `tests/` and `tests/client/` and runs
them with `node --test` ([`project.json`](project.json)). The tests cover the
session manager over a fake sandbox
([`tests/session.test.ts`](tests/session.test.ts),
[`tests/support/sandbox.ts`](tests/support/sandbox.ts)), the provider
([`tests/provider.test.ts`](tests/provider.test.ts)), the status and window
decisions ([`tests/status.test.ts`](tests/status.test.ts)), the views owner
([`tests/views.test.ts`](tests/views.test.ts)), the client's call, dial and
mirror ([`tests/api.test.ts`](tests/api.test.ts),
[`tests/dial.test.ts`](tests/dial.test.ts),
[`tests/store.test.ts`](tests/store.test.ts)), the client sheet
([`tests/styles-cascade.test.ts`](tests/styles-cascade.test.ts)), and the pane
in `happy-dom` ([`tests/client/sidebar.test.ts`](tests/client/sidebar.test.ts),
[`tests/client/story-pane.test.ts`](tests/client/story-pane.test.ts), which
renders the stories of [`stories/`](stories/elements.stories.tsx)).
