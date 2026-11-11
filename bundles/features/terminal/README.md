# Terminal bundle

`terminal` gives the Doric agent a shell in its Project's sandbox: it runs
builds, tests and scripts in the foreground or the background, and gets the
result back as compact output. You see the same sessions in the desktop app,
and can open your own manual terminal next to the agent's.

It is a feature bundle with a host part (the `terminal` tool and the session
registry) and a client part (the desktop UI), loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tool:** `terminal`, tracked shell commands in the thread's working
  directory (order 500, always available).
- **Contract:** `terminal/v1@1.2.0`, the tracked commands of the calling
  prompt's Thread (`run`) and the terminal sessions of every Project (`list`,
  `create`, `snapshot`, `input`, `resize`, `stop`, `rename`, and the
  `watchProject` stream). A session may carry a `name` (1.2.0).
- **UI:** the header's "New terminal" button, the sidebar's terminal rows and
  the workspace terminal tab, with their context menus.

## Names and menus

- `rename(terminalId, name)` names a session, up to 80 characters. The host
  trims the name; `null`, an empty or a whitespace-only name clears it. The
  name lives with the session in memory and reaches every window through the
  session's `updated` notice; `false` means no such session.
- A row and its tab show the name, else the command (a tab with neither says
  "Terminal"). On each `updated` notice the client retitles the terminal's tab
  through `layout.tabs/v1.retitle`, so the tab follows a rename, a cleared
  name and the command a manual shell runs.
- The terminal tab's context menu holds Kill terminal (destructive), above
  the layout's "Close tab". Close tab only closes the tab; the process keeps
  running and its row stays. Kill terminal stops it, as the row's stop button
  does.
- A terminal row's context menu holds Rename, Copy command and Kill terminal.
  Rename turns the row into a name field: Enter sends the trimmed text (empty
  clears the name), Escape or leaving the field cancels. The field closes
  whatever the answer; a failed call keeps the old name and shows a toast.
  Copy command puts the session's command on the clipboard.
- The bundle requires `layout.tabs/v1@^1.2.0`, whose tabs take a `menu` and
  `retitle`.

## The `terminal` tool

The tool runs a command in the current working directory; a relative
`working_directory` resolves against it.

- In the foreground it returns compact output (head and tail lines with
  omitted counts) and the exit status.
- With `background`, the agent keeps working and the host delivers the
  terminal result to the Thread when the command ends.
- With `pty`, it runs an interactive command, with stdout and stderr combined.

## How it works

- **Host part** (`src/host`): the registry, the `terminal/v1` provider, the
  `terminal` tool and the cleanup on `runtime.hooks/v1.onThreadsClosingHook`,
  which closes a closing Thread's sessions; a failed cleanup is logged and
  never fails the close. The registry tracks commands through OSC 633;E
  markers and redacts stored secrets from the stream chunk by chunk, with the
  list `secrets/v1` delivers, read again right before a terminal starts.
- **Client part** (`src/client`): the window's terminal store and the
  elements `terminal-new-button`, `terminal-rows` and `terminal-view`.
  `registerTerminalSurfaces` adds the header button (`layout.header`) and the
  sidebar's terminal rows while the layout serves `layout.sidebar/v1`; from
  `layout.sidebar/v1` 1.1.0 its `busy` answer keeps a Thread active while an
  agent terminal under it is busy.
- `create` opens a manual bash PTY in a Thread's working directory, bringing
  its Project back first.

`terminal/contracts` keeps `TerminalV1` (`run` only) for the 1.0.0
consumers; `TerminalServiceV1` is the full 1.2.0 contract. The `runtime`
bundle delegates its terminal reads to this bundle while it is active.

## Development

```console
npx nx build bundle-terminal
npx nx typecheck bundle-terminal
npx nx test bundle-terminal
```

To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
