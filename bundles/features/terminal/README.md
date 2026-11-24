# terminal

`terminal` gives the agent and the reader a shell in a Thread's Project
sandbox. The agent runs commands through the `terminal` tool, in the
foreground or in the background; the reader opens manual bash shells. The
bundle holds every session in the host's memory, serves them to other bundles
and windows through `terminal/v1`, and draws them in the window: the header's
New terminal button, the terminal rows of the sidebar, the terminal tab of the
workspace, and the `terminal` calls and background results of the chat.

The features this bundle takes part in, and the flow across bundles, are in
the feature docs: [Terminal](../../../docs/features/terminal.md),
[Default agent](../../../docs/features/default-agent.md),
[Projects and Threads](../../../docs/features/projects-and-threads.md),
[UI redesign](../../../docs/features/ui-redesign.md),
[Error messages](../../../docs/features/error-messages.md),
[Credentials](../../../docs/features/credentials.md),
[Current working directory tool](../../../docs/features/cwd-tool.md),
[Git](../../../docs/features/git.md) and
[Host API](../../../docs/features/host-api.md). How bundles are loaded,
declared and called is in [`packages/bundle`](../../../packages/bundle/README.md).

## Manifest

[`manifest.json`](manifest.json):

| Field          | Value                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`           | `terminal` (the package name of [`package.json`](package.json))                                                                                                                                                                                                                                                                                                                 |
| `version`      | `1.2.1`                                                                                                                                                                                                                                                                                                                                                                         |
| `engines`      | `doric` `^1.10.0`                                                                                                                                                                                                                                                                                                                                                               |
| `description`  | Tracked shell commands and manual terminal sessions.                                                                                                                                                                                                                                                                                                                            |
| `provides`     | `terminal/v1@1.3.0`                                                                                                                                                                                                                                                                                                                                                             |
| `requires`     | `tools/v1@^1.5.0`, `secrets/v1@^1.3.0`, `hooks/v1@^1.1.0`, `log/v1@^1.0.0`, `runtime.workspace/v1@^1.3.0`, `runtime.threads/v1@^1.2.0`, `runtime.hooks/v1@^1.1.0`, `ui/v1@^1.0.0`, `regions/v1@^1.0.0`, `navigation/v1@^1.0.0`, `workspace.selection/v1@^1.0.0`, `runtime.records/v1@^1.0.0`, `layout.tabs/v2@^2.0.0`, `workspace.sidebar/v1@^1.0.0`, `runtime.lease/v1@^1.5.0` |
| `optional`     | `files.refresh/v1`, `chat.views/v1`                                                                                                                                                                                                                                                                                                                                             |
| `desktopScope` | `terminal/v1`: `projectId`, `threadId`, `promptId`                                                                                                                                                                                                                                                                                                                              |

The package exports `./host`, `./contracts`, `./contracts/gen/*` (the protobuf-es code `generate-proto` writes from `proto/`) (built to `dist/`) and
`./package.json` ([`package.json`](package.json)). The client part is built by
the bundle CLI and is not a package export.

## Parts

- **Contracts** ([`src/contracts/index.ts`](src/contracts/index.ts)), exported
  as `terminal/contracts`: the types, schemas and references of `terminal/v1`
  and the constant `terminalNameLimit`.
- **Host** ([`src/host/index.ts`](src/host/index.ts)): `activate` creates the
  redaction list, the notice emitter and the session registry, provides
  `terminal/v1`, registers the `terminal` tool with `tools/v1` as always
  available at the order 500, and, while `runtime.hooks/v1` is served,
  registers the `onThreadsClosingHook` handler. Its cleanup disposes the hook
  registration, the tool and the redaction watch. The same file exports
  `createTerminalHost`, the provider, the closing handler and the dispose
  without the kernel wiring.
- **Process host** ([`src/host/main.ts`](src/host/main.ts)):
  `createTerminalProcessHost` runs the host part as its own process (phase 3,
  slice S54b, of
  [`grpc-processes.md`](../../../docs/designs/grpc-processes.md#sandbox-leases)),
  serving `terminal/v1` 1.3.0 (the shape is unchanged; `git` and `transport`
  use it), the `terminal` tool and the `runtime.hooks/v1` handler. A terminal
  opens a Thread session with `withThreadSession` of `runtime/contracts`,
  calls `runtime.lease/v1.Start` with its `threadSessionId`, ends the session
  on the `started` item, and keeps the `Start` stream, opened `detached` so it
  outlives the handler call, for the terminal's life. The redaction list
  follows `secrets/v1.WatchRedactions`, which is not reopened after a failure.
  `run` on an inactive Thread fails `internal` `Thread is inactive.`; when the
  sandbox refuses `Start` with `unsupported_operation` (no live processes),
  `run` and `create` fail `unsupported_operation`
  `Live terminals are unavailable.`. Terminals end with
  the instance.
- **Client** ([`src/client/index.ts`](src/client/index.ts)): `activate` creates
  the window's terminal API, output watches and store over `terminal/v1`,
  defines six elements through `ui/v1` (`terminal-new-button`,
  `terminal-rows`, `terminal-view`, `terminal-tab-icon`, `terminal-tool-call`
  and `terminal-result`), registers the two chat drawings while
  `chat.views/v1` is served, each in a `whenAvailable` of its own, and
  registers the header button and the sidebar rows while
  `workspace.sidebar/v1` is served. Its cleanup undoes them in reverse order,
  disposes the store and closes every watch.

The bundle has no desktop part.

## The `terminal/v1` contract

`terminal/v1` 1.2.0 is the interface `TerminalService`, referenced as
`TerminalServiceV1`. `TerminalV1` references the same id typed with `run`
only. Both are exported from
[`src/contracts/index.ts`](src/contracts/index.ts), with the method schemas
`terminalMethods` (`run`) and `terminalServiceMethods` (every method). The
provider is [`src/host/provider.ts`](src/host/provider.ts). Each method takes an
optional last argument `call`, the platform's call context; a method whose
input fails its schema is refused by the platform with `invalid_input`.

### Types

```ts
interface TerminalInput {
  command: string;
  cwd: string;
  timeoutMs: number; // 0: no limit
  background?: boolean;
  pty?: boolean;
} // strict: an unknown field is refused

interface TerminalResult {
  terminalId: string;
  stdout: string;
  stderr: string;
  exitCode: number; // -1 when the process reports none
  durationMs: number;
  reason: 'exited' | 'timeout' | 'terminated' | 'failed';
}

interface BackgroundTerminal {
  terminalId: string;
  background: true;
}

interface TerminalSession {
  id: string; // a random UUID
  projectId: string;
  threadId: string;
  origin: 'agent' | 'user'; // agent: a `run`; user: a manual shell
  command: string;
  cwd: string;
  startedAt: string; // ISO 8601
  timeoutMs: number | null; // null: no limit
  state: 'starting' | 'running' | 'exited';
  pty: boolean;
  name?: string; // trimmed, never empty; absent when none
}

interface TerminalOutput {
  projectId: string;
  threadId: string;
  terminalId: string;
  data: string;
  offset: number; // exclusive UTF-16 offset after this chunk
}

interface TerminalSnapshot {
  terminal: TerminalSession;
  output: string;
  offset: number;
  truncated: boolean; // the cursor is older than the retained output
}

interface TerminalSize {
  cols?: number;
  rows?: number;
}

type TerminalWatchItem =
  | { kind: 'snapshot'; projectId: string; terminals: TerminalSession[] }
  | { kind: 'updated'; terminal: TerminalSession }
  | { kind: 'removed'; projectId: string; threadId: string; terminalId: string }
  | { kind: 'output'; output: TerminalOutput };

const terminalNameLimit = 80;
```

The schemas of the results, sessions, outputs and snapshots accept unknown
fields; the schemas of `TerminalInput`, `TerminalSize` and each
`TerminalWatchItem` refuse them.

### Methods

| Method                              | Input schema                                                              | Answer                                                                                                                                                                                                                                         | Window |
| ----------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `run(input)`                        | `TerminalInput`                                                           | Starts one agent command on the calling prompt's Thread. A foreground command resolves with its `TerminalResult` when it ends; a background one resolves at once with `BackgroundTerminal` ([Background results](#background-results)).        | No     |
| `list(projectId)`                   | a string                                                                  | The Project's sessions, in start order.                                                                                                                                                                                                        | Yes    |
| `create(threadId, size)`            | `[string, TerminalSize]`                                                  | Opens a manual shell in the Thread's working directory, with no time limit, and resolves with its session. `undefined` is `terminal_unavailable`: no such Thread, a finished one, a closing Thread or Project, or a Project without a sandbox. | Yes    |
| `snapshot(terminalId, after)`       | `[string, number]`                                                        | The retained output after the offset `after`, with the session, the current offset and `truncated`. `undefined` is `terminal_missing`.                                                                                                         | Yes    |
| `input(terminalId, data)`           | `[string, string]`                                                        | Writes `data` to the process and resolves `true`. `false` is `terminal_missing`: no such session, or its process has not started yet.                                                                                                          | Yes    |
| `resize(terminalId, cols, rows)`    | `[string, number, number]`                                                | Resizes the process's terminal and resolves `true`. `false` as for `input`.                                                                                                                                                                    | Yes    |
| `stop(terminalId)`                  | a string                                                                  | Stops the process, removes the session and resolves `true`; `false` when no such session existed. A second `stop` of the same session waits for the first.                                                                                     | Yes    |
| `rename(terminalId, name)`          | `[string (at least 1 character), string (at most 80 characters) \| null]` | Sets the session's `name` to the trimmed `name`; `null`, an empty or a whitespace-only name removes it. The session's `updated` item carries the result. `false` is `terminal_missing`.                                                        | Yes    |
| `watchProject(projectId, listener)` | `[string, stream listener of TerminalWatchItem]`                          | The Project's stream ([The stream](#the-stream)). Returns a `Disposable`.                                                                                                                                                                      | Yes    |

"Window" is whether the method is defined with `expose: 'desktop'`, so that a
desktop window may call it ([`src/host/provider.ts`](src/host/provider.ts)).
`run` is reachable only from the host.

### `run`

In order ([`src/host/provider.ts`](src/host/provider.ts)):

1. It rejects with the call's abort reason when the call is already aborted.
2. It rejects with `Thread is inactive.` when the call's scope has no
   `threadId` or no `promptId`.
3. It calls `runtime.workspace/v1.withThread(threadId, { exclusive: false },
task)`. Inside the task it rejects with `Thread is inactive.` when the
   Thread or its Project is closing, reads the redaction list again
   (`secrets/v1.redactions()`), and starts the session with the origin
   `agent` in the Thread's sandbox. A foreground command takes the call's
   abort signal, so aborting the prompt stops it with the reason
   `terminated`; a background one does not, and outlives the prompt.
4. When `withThread` answers anything but `ready` (`missing`, `inactive` or
   `pending`), it rejects with `Thread is inactive.`

### `create`

`create` calls `runtime.workspace/v1.withThread(threadId, { exclusive: true,
resume: true }, task)`, which brings the Thread's Project back when the host
does not hold it. The task reads the redaction list again and starts a session
with the origin `user`, the command `bash`, the Thread's working directory,
`timeoutMs` 0 and `pty: true`, passing `cols` and `rows` when given. Any
answer of `withThread` but `ready` resolves `undefined`
([`src/host/provider.ts`](src/host/provider.ts)).

### The stream

`watchProject` ([`src/host/watch.ts`](src/host/watch.ts)):

- It starts following the registry's notices, then, in a microtask, sends one
  `snapshot` item with the Project's sessions. Every subscribe gets its own
  snapshot.
- `updated` and `removed` items of the Project that arrive before the snapshot
  are kept and sent right after it, in order; later ones are sent at once.
- `output` items are sent only after the snapshot; output that arrives before
  it is dropped, never buffered. A reader that needs the earlier output reads
  `snapshot`.
- Items of another Project are never sent.
- A listener that throws or rejects is ignored: it never reaches the registry
  or another listener. After `dispose` nothing more is sent.

## Sessions

The registry ([`src/host/registry.ts`](src/host/registry.ts)) holds every
session in a map in the host's process memory. A session belongs to one Thread
and runs in that Thread's Project sandbox. Nothing is stored, so no session
survives a host restart.

### Starting

- A sandbox without live processes (no `start`) refuses the start with
  `Live terminals are unavailable.`
- The session is created in the state `starting`, with a random UUID, its
  command redacted, `timeoutMs` set to `null` for 0, and `pty` false unless
  given, and an `updated` notice is sent. When the process has started it
  moves to `running`, with another `updated` notice.
- An agent command runs as `sh -lc <command>`. A manual shell runs
  `bash -c 'exec bash --noprofile --rcfile /dev/fd/3 -i'` with an init script
  whose `PROMPT_COMMAND` prints `ESC ]633;E;bash BEL` and whose `DEBUG` trap
  prints `ESC ]633;E;<command> BEL` for each command it runs.
- A PTY session runs with `tty: true` and the environment `TERM=xterm-256color`
  and `COLORTERM=truecolor`, and combines stdout and stderr. A plain session
  keeps them apart.
- A positive `timeoutMs` starts a timer that stops the process when it fires.
- When the start fails, or the session is stopped while it starts, the session
  is removed and the start rejects.

### The command of a manual shell

For a session with the origin `user`, the registry reads each OSC 633;E
marker out of the output: it takes the text up to the next BEL, redacts it,
removes the control characters (below 32 and 127), keeps at most 512
characters, and uses `bash` when nothing is left. That text becomes the
session's `command`, with an `updated` notice. The marker is removed from the
output. A marker split across output chunks is still read, and a marker with
no BEL within 8,192 characters is passed through as output. The registry never
reads the command from keystrokes.

### Output

- Each output chunk is redacted and appended to the session's retained output,
  which keeps the last 1,048,576 UTF-16 characters. The session's offset counts
  every character sent, so `snapshot(id, after)` answers the retained output
  after `after` and marks it `truncated` when `after` is older than the
  retained output.
- Each chunk is sent as an `output` notice with its offset.
- Redaction replaces each non-empty secret of the redaction list with
  `[REDACTED]`. The end of a chunk that could be the start of a secret is held
  back until the next chunk, and sent when the process ends.
- Output of a session that was removed is dropped.

### Ending

- A process that exits gives the reason `exited` with its exit code, or -1
  when it has none. A timeout gives `timeout`, and a stop or an aborted prompt
  `terminated`.
- A process the sandbox fails gives `exitCode` -1, empty stdout, and the
  stderr `Terminal timeout exceeded.`, `Terminal terminated.` or `Terminal
execution failed.` with the reason `timeout`, `terminated` or `failed`.
- The `stdout` and `stderr` of a `TerminalResult` are the process's own
  streams, as the sandbox returns them; the registry does not redact them.
- When an agent command ends, its session is removed at once, with a
  `removed` notice. A manual shell whose process exits stays, in the state
  `exited`, until it is stopped.
- `stop` aborts the process, waits for it to terminate and removes the
  session.

### Redaction list

[`src/host/redactions.ts`](src/host/redactions.ts) keeps the last list
`secrets/v1.watchRedactions` delivered, and `run` and `create` read
`secrets/v1.redactions()` again right before each start. The registry reads
the kept list for each chunk. Without change notices (a `watchRedactions` that
throws) the list is still read before every start. The registry redacts only
this list.

### Closing Threads

The `onThreadsClosingHook` handler of `runtime.hooks/v1` stops every session
of the closing Threads. A failure logs `Terminal cleanup failed` with
`{ projectId }`, and the handler never rejects
([`src/host/index.ts`](src/host/index.ts)). When the runtime fires the hook is
in the [runtime README](../../runtime/runtime/README.md).

## The `terminal` tool

[`src/host/tool.ts`](src/host/tool.ts) defines the tool `terminal`, which
[`src/host/index.ts`](src/host/index.ts) registers as always available at
the model-visible order 500. Its description is: "Executes tracked shell
commands in the current working directory. Foreground returns compact output
and exit status. Set background to continue working immediately; the host
delivers the terminal result to this Thread when it ends. Set pty for
interactive commands (stdout and stderr are combined). A relative
working_directory resolves against the current directory."

### Input

```ts
{
  command: string;
  working_directory?: string;
  timeout_ms?: number; // integer, 0 or more
  background?: boolean;
  pty?: boolean;
} // strict
```

- The tool reads the Thread's working directory through
  `runtime.workspace/v1.cwd(call)`. A missing or blank `working_directory` is
  that directory; a relative one is joined to it, an absolute one is used as
  given; the result is normalized as a POSIX path.
- `timeout_ms` defaults to 120,000 and is capped at 600,000; 0 runs with no
  limit.
- The tool calls `run` of `terminal/v1` in the call's scope, with the command,
  the resolved directory, the timeout, and `background` and `pty` when given.
  It has no other way to run a command.

### Output

A background call answers `{ terminal_id, background: true }` at once. A
foreground call waits and answers the record `terminal.compact.v1`:

```ts
{
  schema: 'terminal.compact.v1';
  trace_id: string | null;
  command: string;
  working_directory: string;
  exit_code: number;
  duration_ms: number;
  termination_reason?: 'exited' | 'timeout' | 'terminated' | 'failed';
  success: boolean; // exit_code 0 and reason `exited`
  stdout: CompactStream;
  stderr: CompactStream;
  diagnostics: Diagnostic[];
  truncation: { truncated: boolean; message: string };
  raw_output_ref: string | null;
  trace_error?: string;
}

interface CompactStream {
  bytes: number; // UTF-8 bytes of the whole stream
  lines: number;
  head: string[];
  tail: string[];
  omitted_lines: number;
  omitted_bytes: number;
  truncated: boolean;
}

interface Diagnostic {
  kind: string;
  stream: 'stdout' | 'stderr';
  line: number; // 1-based
  text: string;
  context: { line: number; text: string }[];
  repeat_count?: number;
}
```

- **Compaction.** A stream is split into lines (when it ends with a line
  break, its trailing white space is dropped). A line longer than 1,000
  characters keeps its first 1,000 and the suffix
  ` [line truncated; <n> chars omitted]`. A stream of at most 12,000 bytes is
  returned whole in `head`. A longer one returns its first 24 lines in `head`
  and its last 48 in `tail`, with the count and the UTF-8 bytes of the lines
  between, and `truncated: true`.
- **Truncation.** `truncation.truncated` is true when either stream was
  compacted; its `message` is then `terminal output compacted; full raw output
is available at raw_output_ref`, else `terminal output fits in compact
payload`.
- **Trace.** The host registers the tool without a trace directory, so
  `trace_id` and `raw_output_ref` are `null` and `trace_error` is absent.
- **Diagnostics.** Each line of both streams is classified by the first rule
  it matches: `rust_error` (`error[E`), `test_failure` (`test result: failed`,
  a line `failures:`, ` failures`, `FAILED`), `cargo_error` (`could not
compile`, `test failed`), `panic` (`panicked at`, ` panicked`), `exception`
  (`Traceback`, `Exception`, `Caused by:`), `typescript_error` (`error TS`, or
  `TS` and four digits), `eslint_error` (`parsing error`, `no-unused-vars`,
  `problems`), `error` (`error:` at the start, ` error:`, `ERROR`, `Error:`),
  `warning` (`warning:` at the start, ` warning:`, `WARN`, `Warning:`).
  These texts are matched ignoring case: `test result: failed`, `failures:`,
  ` failures`, `could not compile`, `test failed`, `panicked at`,
  ` panicked`, `parsing error`, `no-unused-vars`, `problems`, `error:`,
  ` error:`, `warning:` and ` warning:`; the others match their case. Each
  carries two lines of context on each side. A line of the same kind, stream
  and text as an earlier one adds to the earlier one's `repeat_count`
  instead. The diagnostics are sorted with every kind but `error`,
  `eslint_error` and `warning` first, then `error` and `eslint_error`, then
  `warning`; then `stderr` before `stdout`; then by line; and the first 20
  are kept. When the command runs `cargo test`, `cargo check` or `cargo
clippy`, each stdout line that starts with `test ` and holds `FAILED` is
  appended after them as `cargo_test_failure`, with no context.

## Background results

When a background command ends, the provider sends its result once to the
Thread through `runtime.threads/v1.enqueueTerminalResult({ threadId,
promptId, terminalId, text })`. `text` is this Markdown, with the last 12,000
characters of each stream ([`src/host/provider.ts`](src/host/provider.ts)):

```md
# Background terminal result

Terminal: <terminalId>
Originating prompt: <promptId>
Command: <command>
Exit code: <exitCode>
Reason: <reason>
Duration: <durationMs> ms

## Standard output (last 12000 characters)

<stdout>

## Standard error (last 12000 characters)

<stderr>
```

When the result or `enqueueTerminalResult` rejects, the provider calls
`runtime.threads/v1.failTerminalResult({ threadId })`; when that rejects too,
it logs `Terminal result delivery failed` with `{ threadId }`. A manual shell
never sends anything to its Thread. How the runtime redacts and delivers the
text, as a prompt of the input source `terminal`, is in the
[runtime README](../../runtime/runtime/README.md) and the feature doc
[Terminal](../../../docs/features/terminal.md).

## Contracts used

| Contract                      | Part   | Use                                                                                                                                                                                                         |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools/v1`                    | host   | Registers the `terminal` tool ([`src/host/index.ts`](src/host/index.ts)).                                                                                                                                   |
| `secrets/v1`                  | host   | `redactions()` and `watchRedactions()`, the redaction list ([`src/host/redactions.ts`](src/host/redactions.ts)).                                                                                            |
| `hooks/v1`                    | host   | `whenAvailable(runtime.hooks/v1)` to register the closing handler ([`src/host/index.ts`](src/host/index.ts)).                                                                                               |
| `log/v1`                      | host   | The two error lines of [Side effects](#side-effects).                                                                                                                                                       |
| `runtime.workspace/v1`        | host   | `withThread` for `run` and `create`; `cwd` for the tool ([`src/host/provider.ts`](src/host/provider.ts), [`src/host/tool.ts`](src/host/tool.ts)).                                                           |
| `runtime.threads/v1`          | host   | `enqueueTerminalResult` and `failTerminalResult` ([`src/host/provider.ts`](src/host/provider.ts)).                                                                                                          |
| `runtime.hooks/v1`            | host   | `onThreadsClosingHook` ([`src/host/index.ts`](src/host/index.ts)).                                                                                                                                          |
| `ui/v1`                       | client | Defines the six elements; creates the chat's `chat-readonly-markdown` element ([`src/client/index.ts`](src/client/index.ts), [`src/client/chat/terminal-result.tsx`](src/client/chat/terminal-result.tsx)). |
| `regions/v1`                  | client | Adds the New terminal button to `shell.header.actions` ([`src/client/index.ts`](src/client/index.ts)).                                                                                                      |
| `navigation/v1`               | client | Navigates to a terminal's Thread; reads the route to mark the selected row ([`src/client/index.ts`](src/client/index.ts), [`src/client/elements.tsx`](src/client/elements.tsx)).                            |
| `workspace.selection/v1`      | client | The selected Thread of the New terminal button ([`src/client/elements.tsx`](src/client/elements.tsx)).                                                                                                      |
| `workspace.sidebar/v1`        | client | `addThreadRows` for the terminal rows and the `busy` answer ([`src/client/index.ts`](src/client/index.ts)).                                                                                                 |
| `runtime.records/v1`          | client | A Thread's `projectId` and `parentThreadId` ([`src/client/index.ts`](src/client/index.ts), [`src/client/elements.tsx`](src/client/elements.tsx)).                                                           |
| `layout.tabs/v2`              | client | `open`, `close` and `retitle` of terminal tabs; `current` and `subscribe` to mark the selected row ([`src/client/index.ts`](src/client/index.ts), [`src/client/elements.tsx`](src/client/elements.tsx)).    |
| `files.refresh/v1` (optional) | client | `request(projectId)` when a Project's terminal activity changes ([`src/client/store.ts`](src/client/store.ts)).                                                                                             |
| `chat.views/v1` (optional)    | client | `registerToolRenderer` and `registerInputRenderer` ([`src/client/index.ts`](src/client/index.ts)).                                                                                                          |
| `doric.connection/v1`         | client | The connection status the watches resubscribe on ([`src/client/output-watch.ts`](src/client/output-watch.ts)).                                                                                              |

The host part reaches the three runtime contracts through local structural
copies narrowed to what it calls ([`src/host/peers.ts`](src/host/peers.ts)).
The client part imports the contracts of `runtime`, `workspace` and `layout`
and the chat's types (types only) through
[`src/client/peers.ts`](src/client/peers.ts), builds `chat.views/v1` from its
id, and reaches `files.refresh/v1` through a structural copy narrowed to
`request`.

Other bundles use `terminal/v1`: `git` reads `list` for its busy check, and
`transport` serves the sessions through REST routes and its `/projects`
Socket.IO namespace (see the [git](../git/README.md) and
[transport](../../foundation/transport/README.md) READMEs).

## The window

### Terminal API

[`src/client/api.ts`](src/client/api.ts) wraps every `terminal/v1` call a
window makes (`list`, `create`, `snapshot`, `input`, `resize`, `stop`,
`rename`). The calls carry no deadline.

- It checks the arguments before calling: an id must be a non-empty string of
  at most 200 characters without NUL (`The item identifier is invalid.`);
  input must be a string of at most 65,536 characters (`Terminal input is
invalid.`); columns and rows must be integers from 1 to 1,000 (`Terminal
dimensions are invalid.`).
- A rejected call with the code `unavailable`, `disconnected` or
  `generation_lost` becomes `Doric backend is unavailable.`; any other becomes
  `Doric could not complete the terminal request.`
- `create` sends an empty size and treats `undefined` as `Doric could not
complete the terminal request.` `snapshot` always reads from offset 0, treats
  `undefined` the same way, and refuses an answer whose `output`, `offset` or
  `truncated` has the wrong type, or whose `offset` is smaller than its output's
  length, with `Doric returned an invalid terminal snapshot.` `input` and
  `resize` treat `false` as `Doric could not complete the terminal request.`;
  `stop` ignores its answer; `rename` returns it.
- Each session record is checked field by field and copied; a bad one is
  `Doric returned an invalid terminal.`
- Writes to one terminal run one after another, in the order they were made,
  whatever the outcome of the one before
  ([`src/client/input-queue.ts`](src/client/input-queue.ts)).

### Watches

[`src/client/output-watch.ts`](src/client/output-watch.ts):

- **Project watch.** `watchProject(projectId, listener)` keeps one listener per
  Project; a newer one replaces the older. It forwards `snapshot` (the checked
  sessions of that Project), `updated` and `removed` items of that Project and
  ignores `output`. A session that fails the check reports `The terminal list
could not be read.` or `The terminal could not be read.`
- **Output watch.** `watch(terminalId, 0, listener)` first reads the terminal's
  snapshot to learn its Project (a failed read reports `The terminal is no
longer available.`), then follows that Project's stream. On each stream
  `snapshot` it reads the terminal's snapshot again and sends it; output that
  arrives meanwhile is buffered and sent after it, and when the buffer passes
  2,097,152 characters the snapshot is read again instead. Output is matched
  by offset: what was seen is dropped, an overlap sends only the unseen part,
  and a gap reads the snapshot again.
- **Sharing.** All the watchers of one terminal share one output watch. Every
  watcher gets every update; a watcher that joins later makes the watch read
  the snapshot again for all, or gets the error that ended it. The watch
  closes when its last watcher stops.
- **Reconnecting.** A stream that ends with `disconnected`, `unavailable` or
  `generation_lost` reports nothing and subscribes again when
  `doric.connection/v1` reports `connected`, or after 1,000 ms when it is
  connected already. An end with any other error reports `The terminal
connection failed.` and stays ended; an end without an error reports
  nothing and stays ended.

### Store

[`src/client/store.ts`](src/client/store.ts) holds, for each followed Project,
its list of sessions, kept by the Project watch.

- `follow(projectId)` starts the watch once; `unfollow` stops it and drops the
  list. `terminals()` is every followed Project's sessions; `threadTerminals`
  filters them by Thread.
- A session that leaves its Project's list (by `removed`, or missing from a new
  snapshot) closes its tab `terminal:<id>` through `layout.tabs/v2.close`.
- Each `updated` session retitles its tab through `layout.tabs/v2.retitle`
  with its title: its `name`, else its `command`, else `Terminal`.
- When the id, state, command or working directory of any session of a Project
  changes, the store calls `files.refresh/v1.request(projectId)`, when the
  files bundle serves it.
- `create(threadId)` creates a manual shell, adds it to the list and opens its
  tab. `stop(id)` stops a session. `rename(id, name)` renames one. A failure of
  any of them, and every error a watch reports, is a toast with its message.

### Header button

The element `terminal-new-button` is added to the region
`shell.header.actions` with the id `terminal-new` and the order 10. It is an
icon button labelled "New terminal", titled "Open terminal", disabled until a
Project and a Thread are selected (`workspace.selection/v1`); a click runs the
store's `create` for the selected Thread
([`src/client/index.ts`](src/client/index.ts),
[`src/client/elements.tsx`](src/client/elements.tsx)).

### Sidebar rows

`registerTerminalSurfaces` registers, through `workspace.sidebar/v1`, the
Thread rows `{ id: 'terminals', tag: 'terminal-rows' }`
([`src/client/index.ts`](src/client/index.ts)):

- `count(threadId)` follows the Thread's Project (read from
  `runtime.records/v1`) and answers the number of the Thread's sessions.
- `busy(threadId)` answers whether the Thread has an agent session that has not
  exited. It answers from memory: each Thread's Project is resolved once, and
  the set of busy Threads is rebuilt only after the store changes.

The element `terminal-rows` ([`src/client/elements.tsx`](src/client/elements.tsx),
[`src/client/rows/terminal-rows.tsx`](src/client/rows/terminal-rows.tsx)):

- It draws the Thread's sessions one level deeper than the Thread, counted
  through `parentThreadId`.
- An agent row reads `<name or command> · mm:ss (<timeout>)`, its elapsed time
  updated each second, the timeout written as `no limit`, `<1 sec`, or minutes
  and seconds (`2 min`, `1 min 30 sec`). A manual row reads its name, else its
  command. Only rows of agent sessions run the one-second clock
  ([`src/client/domain/terminals.ts`](src/client/domain/terminals.ts)).
- The row of the terminal whose tab is selected, on that Thread's route, is
  marked `aria-current="true"`; the rows read the tabs only while the Thread
  has sessions.
- A click navigates to `/projects/<projectId>/threads/<threadId>` when the
  window's records hold the Thread, then opens the terminal's tab, or shows it
  when it is open. A failure is a toast with its message, or `Could not open
terminal.`
- A stop button, labelled "Stop terminal" for an agent session and "Discard
  terminal" for a manual one, stops the session.
- The context menu holds Rename, Copy command and Kill terminal (destructive,
  which stops the session). Copy command writes the command to the clipboard;
  a refusal is the toast `Could not copy the command.` Rename turns the row
  into a field labelled "Terminal name" holding the current name (at most 80
  characters, the command as placeholder): Enter sends the trimmed text, or
  `null` when it is empty; Escape or leaving the field closes it unsent. The
  field is read-only while the call runs and closes whatever the answer, so a
  failed call keeps the old name.

### Tab

A terminal's tab ([`src/client/tab.ts`](src/client/tab.ts)) is opened through
`layout.tabs/v2.open` with:

- `id` `terminal:<terminalId>`, `title` the session's title, `tag`
  `terminal-view`, `props` `{ terminalId, showHeader }` (`showHeader` false for
  a manual shell);
- `iconTag` `terminal-tab-icon`, an element that draws the terminal mark;
- `menu` with one destructive item, Kill terminal, which stops the session.

Closing the tab closes only the tab: the process keeps running and its row
opens it again.

### Terminal view

The element `terminal-view` draws the session the store holds for
`terminalId`, and nothing when there is none
([`src/client/elements.tsx`](src/client/elements.tsx),
[`src/client/view/terminal-view.tsx`](src/client/view/terminal-view.tsx)):

- It loads xterm and its fit addon with a dynamic import, once per window
  ([`src/client/view/xterm.ts`](src/client/view/xterm.ts)), and opens an
  emulator with 10,000 lines of scrollback, the font of the view, a blinking
  cursor, input disabled for an exited session, and line-feed conversion for a
  session that is not a PTY. Its colors are read from the view's computed
  style and read again on each change of `(prefers-color-scheme: dark)`
  ([`src/client/view/color-scheme.ts`](src/client/view/color-scheme.ts)).
- With `showHeader`, a header shows the command, with ` · exited` once the
  session exited. The section is labelled `Terminal <command>`.
- It watches the output: a snapshot resets the emulator and writes
  `[Earlier output is no longer available]` first when it is truncated; later
  output writes only its unseen part. A watch error is shown in an alert line
  above the emulator until the next update.
- Typed data goes to `input`; a failure is shown in the alert line.
- It fits the emulator to its size and, for a PTY session that has not exited,
  sends `resize` only when the columns or rows change; a refused resize is sent
  again on the next change.

[`src/client/styles.css`](src/client/styles.css) holds the bundle's Tailwind
utilities and the rule that draws xterm's scrollbar slider, scoped to
`[data-slot='terminal-view']`, like the shared ScrollArea's. The sheet also
scans `packages/desktop/src` and the client sources of `layout`, `chat`,
`settings`, `account` and `workspace` (`@source`), so it emits every utility
class the window uses, in one sorted set, and never emits a shared class after
those bundles' responsive variants.

### In the chat

While `chat.views/v1` is served, the bundle registers `terminal-tool-call` as
the drawing of the tool `terminal` and `terminal-result` as the drawing of the
input source `terminal`, each in its own registration, so a refused one leaves
the other. Without `chat.views/v1` it draws nothing in the chat
([`src/client/index.ts`](src/client/index.ts)).

`terminal-tool-call` ([`src/client/chat/terminal-call.tsx`](src/client/chat/terminal-call.tsx)):

- The chat sets its `view` (`ChatToolView`). It reads the call's input and
  result ([`src/client/domain/terminal-tool.ts`](src/client/domain/terminal-tool.ts)):
  a `terminal.compact.v1` record gives the command, directory, exit code,
  duration, reason, success and streams; a background answer gives the
  terminal id; any other result is shown as raw text.
- It follows the call's Project through the store and picks the call's live
  session ([`src/client/domain/live-terminal.ts`](src/client/domain/live-terminal.ts)):
  the one a background answer names; otherwise, while the call runs, the
  agent session of the call's Thread running the call's command, the newest
  one that has not exited, else the newest.
- While that session is `starting` or `running`, the row shows its output
  (the last 32,000 characters, drawn at most every 50 ms,
  [`src/client/chat/live-output.ts`](src/client/chat/live-output.ts)) and a
  Stop button, which stops the session and is gone at once for it.
- The block's header reads `Running`, `Ran` or `Failed` and the command, its
  white space collapsed and cut to 72 characters with `…`, or `terminal` when
  there is none. It is `Failed` when the call failed, `success` is false or the
  exit code is not 0. The body shows the command behind `$`, the streams with
  `… <n> lines omitted …` between head and tail and stderr in the destructive
  color, the raw text, `Started in background` for a background call with
  nothing else to show, and, for a failed call, a compact error notice with
  the fallback code `tool_failed` ("Tool failed") and the context `Tool:
terminal`.
- The block is open while its session runs; otherwise open while the call
  runs and folded once it settles. A reader's click is dispatched as
  `chat-block-chosen` with `{ chosen }` and shown until the chat sets the next
  `view`. The element's `toggle()` reports the opposite of what it shows.

`terminal-result` ([`src/client/chat/terminal-result.tsx`](src/client/chat/terminal-result.tsx)):

- The chat sets its `view` (`ChatInputView`). A text that is the host's
  background result, with every field of
  [Background results](#background-results) present, is read back
  ([`src/client/domain/terminal-result.ts`](src/client/domain/terminal-result.ts))
  and drawn as the same card, headed `Background terminal` or `Background
terminal failed` (when the reason is not `exited` or the exit code is not 0)
  and the command; it is open when failed and folded otherwise. The streams
  are shown whole. Its root carries `data-terminal-id`.
- Any other text is a block labelled `Terminal` holding the chat's read-only
  Markdown element `chat-readonly-markdown`, folded once settled.
- The reader's choice and `toggle()` work as for `terminal-tool-call`.

## Data and persistence

The bundle stores nothing. The host keeps the sessions, their retained output
and the redaction list in memory, and loses them on restart
([`src/host/registry.ts`](src/host/registry.ts),
[`src/host/redactions.ts`](src/host/redactions.ts)). The window keeps each
followed Project's sessions in its store and each watched terminal's cursor in
memory ([`src/client/store.ts`](src/client/store.ts),
[`src/client/output-watch.ts`](src/client/output-watch.ts)). A background
result becomes part of the Thread through the runtime, which stores it.

## Side effects

- Starts processes in a Project's sandbox and writes to and resizes them.
- Sends `updated`, `removed` and `output` items to every `watchProject`
  listener of the Project.
- Enqueues a background result on the Thread through `runtime.threads/v1`.
- Logs only `Terminal cleanup failed` with `{ projectId }` and `Terminal
result delivery failed` with `{ threadId }`, never a command or output
  ([`src/host/index.ts`](src/host/index.ts),
  [`src/host/provider.ts`](src/host/provider.ts)).
- In the window: opens, retitles and closes workspace tabs, navigates to a
  Thread, asks `files.refresh/v1` for a refresh, writes to the clipboard, and
  shows toasts. When `ui/v1` cannot create `chat-readonly-markdown`, a
  `terminal-result` block logs `Doric: <chat-readonly-markdown> could not be
created:` with the error to the console and stays empty
  ([`src/client/chat/terminal-result.tsx`](src/client/chat/terminal-result.tsx)).

## Configuration

The bundle reads no setting and no environment variable. Its behavior depends
only on the composition: without `chat.views/v1` nothing is drawn in the chat,
and without `files.refresh/v1` no file refresh is asked.

## Limits

| Limit                                        | Value                                                 | File                                                                       |
| -------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| Retained output per session                  | 1,048,576 UTF-16 characters                           | [`src/host/registry.ts`](src/host/registry.ts)                             |
| Command read from a marker                   | 512 characters                                        | [`src/host/registry.ts`](src/host/registry.ts)                             |
| Unterminated marker held back                | 8,192 characters                                      | [`src/host/registry.ts`](src/host/registry.ts)                             |
| Session name                                 | 80 characters                                         | [`src/contracts/index.ts`](src/contracts/index.ts)                         |
| Tool timeout                                 | 120,000 ms by default, 600,000 ms at most, 0 for none | [`src/host/tool.ts`](src/host/tool.ts)                                     |
| Whole stream in the tool's answer            | 12,000 bytes                                          | [`src/host/tool.ts`](src/host/tool.ts)                                     |
| Head and tail of a compacted stream          | 24 and 48 lines                                       | [`src/host/tool.ts`](src/host/tool.ts)                                     |
| Line in the tool's answer                    | 1,000 characters                                      | [`src/host/tool.ts`](src/host/tool.ts)                                     |
| Diagnostics, context                         | 20, 2 lines on each side                              | [`src/host/tool.ts`](src/host/tool.ts)                                     |
| Each stream in a background result           | last 12,000 characters                                | [`src/host/provider.ts`](src/host/provider.ts)                             |
| Id, input, columns and rows sent by a window | 200 characters, 65,536 characters, 1–1,000            | [`src/client/api.ts`](src/client/api.ts)                                   |
| Output buffered while a snapshot is read     | 2,097,152 characters                                  | [`src/client/output-watch.ts`](src/client/output-watch.ts)                 |
| Resubscribe delay while connected            | 1,000 ms                                              | [`src/client/output-watch.ts`](src/client/output-watch.ts)                 |
| Emulator scrollback                          | 10,000 lines                                          | [`src/client/view/terminal-view.tsx`](src/client/view/terminal-view.tsx)   |
| Live output of a chat row                    | last 32,000 characters, drawn at most every 50 ms     | [`src/client/chat/live-output.ts`](src/client/chat/live-output.ts)         |
| Command preview in a chat header             | 72 characters                                         | [`src/client/domain/terminal-tool.ts`](src/client/domain/terminal-tool.ts) |

Ordering: a Project's sessions are listed in start order; each listener gets a
Project's items in the order the registry sends them, after its snapshot; a
window's writes to one terminal reach it in the order they were made.

## Errors and failure behavior

| Where                                           | When                                                                                          | What happens                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `run`                                           | No `threadId` or `promptId` in scope; Thread missing, finished, closing, or without a sandbox | Rejects with `Thread is inactive.`; the tool call fails with it.                                                       |
| `run`, `create`                                 | The sandbox has no live processes                                                             | Rejects with `Live terminals are unavailable.`                                                                         |
| `create`                                        | No such Thread, a finished or closing one, no sandbox                                         | Resolves `undefined`; the window shows `Doric could not complete the terminal request.`                                |
| `snapshot`, `input`, `resize`, `rename`, `stop` | No such session                                                                               | `undefined` or `false`, as in [Methods](#methods).                                                                     |
| Any method                                      | Input fails its schema (a name over 80 characters, for one)                                   | Refused by the platform with `invalid_input`.                                                                          |
| Process                                         | Times out, is stopped, or the sandbox fails it                                                | The result carries the reason and, on a sandbox failure, the stderr of [Ending](#ending).                              |
| Background delivery                             | The result or its delivery rejects                                                            | `failTerminalResult`; when that rejects, the log line `Terminal result delivery failed`.                               |
| Closing hook                                    | Stopping a session fails                                                                      | The log line `Terminal cleanup failed`; the close goes on.                                                             |
| Stream listener                                 | Throws or rejects                                                                             | Ignored.                                                                                                               |
| Window calls                                    | Lost connection or host; other failures; bad arguments or answers                             | The messages of [Terminal API](#terminal-api), shown as toasts by the store and the rows, or in the view's alert line. |
| Chat result block                               | `ui/v1` cannot create `chat-readonly-markdown`                                                | The console line `Doric: <chat-readonly-markdown> could not be created:` with the error; the block stays empty.        |
| Window streams                                  | Lost connection; other end; unreadable record; terminal gone                                  | Resubscribe silently; or the messages of [Watches](#watches), as toasts or in the view.                                |

## Build and test

[`project.json`](project.json) declares the Nx project `bundle-terminal` with
three targets:

- `build`: `tsc --build tsconfig.json` (contracts and host to `dist/`),
  `tsc -p tsconfig.client.json` (type-checks the client part, the contracts,
  the stories and `.storybook/`), and the bundle CLI's `build`, which builds
  the client part.
- `typecheck`: the two `tsc` steps without the bundle CLI.
- `test`: builds first, compiles [`tsconfig.spec.json`](tsconfig.spec.json)
  (the host, the contracts, the DOM-free client files it lists and
  `tests/*.test.ts`) and
  [`tsconfig.client-spec.json`](tsconfig.client-spec.json)
  (`tests/client/**`, which boot `happy-dom`) into `dist-tests/`, and runs them
  with `node --test`.

```console
npx nx run bundle-terminal:build
npx nx run bundle-terminal:typecheck
npx nx run bundle-terminal:test
```

[`tests/docker.test.ts`](tests/docker.test.ts) runs the registry against a
real Docker sandbox and is skipped unless `DORIC_TEST_SANDBOX=true`. The
stories under [`stories/`](stories) draw the client elements with the
harness of [`.storybook/preview.tsx`](.storybook/preview.tsx).

To build and stage every bundle the host loads:

```console
npx nx run doric-host:build-bundles
```
