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
  the workspace terminal tab, with their context menus; from 1.2.0, the
  `terminal` call's row and a background terminal's result in the chat
  ([In the chat](#in-the-chat)).

## Names and menus

- `rename(terminalId, name)` names a session, up to 80 characters. The host
  trims the name; `null`, an empty or a whitespace-only name clears it. The
  name lives with the session in memory and reaches every window through the
  session's `updated` notice; `false` means no such session.
- A row and its tab show the name, else the command (a tab with neither says
  "Terminal"). On each `updated` notice the client retitles the terminal's tab
  through `layout.tabs/v2.retitle`, so the tab follows a rename, a cleared
  name and the command a manual shell runs.
- The terminal tab's icon is the `terminal-tab-icon` element (`iconTag`),
  which draws the terminal mark. Its context menu holds Kill terminal
  (destructive), above the layout's "Close tab". Close tab only closes the
  tab; the process keeps running and its row stays. Kill terminal stops it, as the row's stop button
  does.
- A terminal row's context menu holds Rename, Copy command and Kill terminal.
  Rename turns the row into a name field: Enter sends the trimmed text (empty
  clears the name), Escape or leaving the field cancels. The field closes
  whatever the answer; a failed call keeps the old name and shows a toast.
  Copy command puts the session's command on the clipboard.
- The bundle requires `layout.tabs/v2@^2.0.0`, whose tabs take an `iconTag`, a
  `menu` and `retitle`; the terminal rows also read its `current()` and `subscribe()` to
  mark the selected terminal row.

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
  elements `terminal-new-button`, `terminal-rows`, `terminal-view` and
  `terminal-tab-icon`, and, from 1.2.0, `terminal-tool-call` and
  `terminal-result` ([In the chat](#in-the-chat)).
  `registerTerminalSurfaces` adds the header button (`shell.header.actions`) and the
  sidebar's terminal rows while `workspace` serves `workspace.sidebar/v1`;
  its `busy` answer keeps a Thread active while an agent terminal under it is
  busy. The button reads the selected Thread from `workspace.selection/v1`,
  and the rows and a row's click read the Thread records from
  `runtime.records/v1` (terminal 1.1.9). `terminal-rows` reads `layout.tabs/v2`
  `current()`/`subscribe()` and `navigation/v1` to mark the selected terminal
  row (`aria-current="true"`), subscribing only while its Thread has terminals.
- `create` opens a manual bash PTY in a Thread's working directory, bringing
  its Project back first.
- The client's output watches of one terminal share one host stream (1.2.0):
  every watcher gets every chunk, a watcher that joins late makes the watch
  read the snapshot again (or gets the error that ended it), and the stream
  closes when the last watcher stops, so a chat row and a terminal tab
  watching the same terminal do not cut each other off.

`terminal/contracts` keeps `TerminalV1` (`run` only) for the 1.0.0
consumers; `TerminalServiceV1` is the full 1.2.0 contract. It is the one
source of a Project's terminals: the `runtime` bundle holds no terminal reads
(bundle isolation 7(c)), and `git` reads the list for its branch switch.

`src/client/styles.css` ships the xterm scrollbar slider rule, scoped to
`[data-slot='terminal-view']`, which matches ScrollArea's lane; the layout's
sheet no longer carries it.

## In the chat

From 1.2.0 (bundle isolation 5(b)) the client part draws in the chat, through
`chat.views/v1`, listed under `optional`, each registration in a
`whenAvailable` callback of its own, and needs platform 1.10.0
(`engines.doric` `^1.10.0`) for `desktop/ui/collapsible-block`.

From 1.2.1 (bundle isolation 7(c)) the client part imports the `runtime`,
`workspace` and `layout` contracts, and the chat's types from
`chat/contracts`, types only since the chat is optional, all through
`src/client/peers.ts`. `runtime` is a dependency; `workspace`, `layout` and
`chat` are devDependencies. `files.refresh/v1` stays a structural copy, and
the host part keeps its copies of the runtime's shapes
(`src/host/peers.ts`).

- `terminal-tool-call` (`src/client/chat/terminal-call.tsx`) draws each
  `terminal` call, inside the activity group. It follows the call's Project in
  the terminal store and, while the terminal runs, shows its live output (the
  last 32,000 characters, drawn at most every 50 ms) and Stop. Stop calls the
  store's `stop`, whose refusal is the store's toast, and is gone at once for
  that terminal. The row shows the reader's open/close click until the chat
  sets the next `view`; its `toggle()` takes a call whose terminal still runs
  as open.
- `terminal-result` (`src/client/chat/terminal-result.tsx`) draws each prompt
  of the source `terminal`: a background command's result framed by the host
  is the command's block, open when the command did not finish cleanly; its
  copied text is the prompt's text, the host's Markdown frame. A terminal
  prompt without that frame is a block labelled "Terminal" holding its text as
  read-only Markdown, folded once settled.

A failed call's notice falls back to the code `tool_failed`. Without
`terminal` the chat draws a `terminal` call as a generic row and a background
result as plain text.

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
