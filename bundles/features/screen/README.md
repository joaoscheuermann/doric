# Screen bundle

`screen` gives every Project's sandbox a graphical screen you can watch and
drive. Open it from the sidebar and it appears in a desktop window of its own,
showing an xpra HTML5 session that runs inside the sandbox. A GUI program
started on that session's X display, by you or by the agent, draws there.

It is a feature bundle with a host part (the screen sessions), a desktop part
(your screen views and their windows) and a client part (the sidebar's
**Screens** pane), loaded by the `bundle` platform. The path a window loads is
answered by the resident [`screen-relay`](../screen-relay/README.md) bundle.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Contracts:**
  - `screen.sessions/v2` (host): `attach(projectId)` ensures the Project's
    screen session and answers where to load it;
  - `screen.views/v1` (desktop): `list`, `add`, `remove`, `open`, `retry`,
    `deliver` and `watch` over your screen views.
- **UI:** the collapsible **Screens** pane in the sidebar, below the Threads
  tree (`<screen-sidebar>` with the `<screen-group-action>` add control), and
  one native window per view.

The bundle provides no tool and no skill.

## Using it

1. Select a Project and press **+** in the **Screens** header. It adds a view
   for that Project; a Project has at most one view, and adding it again opens
   the existing one.
2. Click the row to open or focus the view's window. A view that is not ready
   yet remembers the request and opens its window once it is.
3. Use the row's retry control when it offers one, or the remove control on
   hover to drop the view.

The pane lists only the views of the selected Project. Each row shows one
state:

| Row text                 | Meaning                                    | Retry |
| ------------------------ | ------------------------------------------ | ----- |
| `Starting…`              | Waiting for the sandbox; retried by itself | No    |
| the display, e.g. `:100` | The screen is ready                        | No    |
| `Sandbox unavailable`    | The sandbox is gone or closing             | Yes   |
| `Screen failed to start` | The xpra session could not be started      | Yes   |
| `No xpra in the image`   | The sandbox image has no `xpra`            | No    |
| `Backend unavailable`    | The window could not reach the host        | Yes   |

## How it works

### Sessions on the host

`attach` runs on the Project's runtime lease and never acquires one, so a
Project whose sandbox is not up answers `pending` or `unavailable`. Every
Thread of a Project shares its one sandbox and therefore its one screen.
Concurrent calls for the same Project share one attempt.

Inside the sandbox, the session manager checks for `xpra`, lists the live
displays and, when no live session can be reused, starts one:

```console
xpra start :<display> --html=on --bind-tcp=0.0.0.0:<port> --daemon=yes --log-file=/tmp/doric-screen.log
```

- the display is `:100` or the next free one, the port `14500`, `14501` or
  `14502`, and the session gets up to 10 seconds to accept connections;
- display, port and a random token are recorded in `/tmp/doric-screen.json`,
  so a restarted host reuses a live session instead of starting a second one,
  and a restarted session keeps its token.

The host part then publishes the session's upstream (the sandbox's address and
port) on `screen.relay/v1` under that token and answers:

```text
{ status: 'ready', path: '/screen/<token>/', display: ':100' }
```

The path is host-relative: the app composes it with the origin it already
reaches the host on, so the screen works when the host runs on another
machine. When the host part deactivates, it asks the relay to forget the tokens
it published.

### Views and windows on the desktop

The desktop part owns your views. It stores them in `views.json` in the
bundle's cache directory (status is never stored; it is asked for again) and
opens one window per view through `doric.windows/v1`:

- key and session partition `screen:<viewId>`, the view's label as the native
  title, no preload and no app chrome, so the window hosts the xpra page alone;
- a waiting or failed view is re-attached every 2 seconds;
- a ready view with an open window is re-attached every 15 seconds, and the
  window is navigated to the new path if the screen moved;
- a view without `xpra` in the image is not retried.

A desktop part cannot call host contracts, so it lists the attaches it wants in
the `watch` stream; the client part calls `screen.sessions/v2.attach` scoped to
that Project and hands the answer back through `deliver`.

## Requirements

- The sandbox image must provide `xpra` with its HTML5 client. The image
  `app/backend/doric-host/.sandbox.Dockerfile` builds installs it.
- The composition must run `screen-relay` resident; without
  `screen.relay/v1`, no screen path is answered.

## Development

```console
npx nx build bundle-screen
npx nx typecheck bundle-screen
npx nx test bundle-screen
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
