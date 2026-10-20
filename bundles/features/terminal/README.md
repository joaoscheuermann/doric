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
- **Contract:** `terminal/v1@1.1.0`, the tracked commands of the calling
  prompt's Thread (`run`) and the terminal sessions of every Project (`list`,
  `create`, `snapshot`, `input`, `resize`, `stop`, and the `watchProject`
  stream).
- **UI:** the header's "New terminal" button, the sidebar's terminal rows and
  the workspace terminal tab.

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
  sidebar's terminal rows while the layout serves `layout.sidebar/v1`.
- `create` opens a manual bash PTY in a Thread's working directory, bringing
  its Project back first.

`terminal/contracts` keeps `TerminalV1` (`run` only) for the 1.0.0
consumers; `TerminalServiceV1` is the full 1.1.0 contract. The `runtime`
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
