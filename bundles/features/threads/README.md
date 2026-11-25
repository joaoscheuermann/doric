# threads

The `threads` bundle lets an agent delegate work to child Threads. Its host
part registers eight tools that create, observe, steer and close the direct
children of the calling prompt's Thread, and ships three skills that teach the
agent to use them. Its client part draws, in the conversation, another Thread's
instruction or result and each `thread-spawn` call.

The flow across bundles (how the runtime creates a child, delivers its result
and frames it) is in the feature doc [Delegation](../../../docs/features/delegation.md).
The other feature docs that name this bundle are
[Per-thread model](../../../docs/features/per-thread-model.md) (the model and
effort of a spawned child), [Coding workflow](../../../docs/features/coding-workflow.md)
(the step agents spawned through `thread-spawn`), [Skills](../../../docs/features/skills.md)
(bundle skill files) and [Error messages](../../../docs/features/error-messages.md)
(the failure notice of a spawn). [`packages/bundle`](../../../packages/bundle/README.md)
describes how bundles are built, loaded and activated.

## Manifest

- `manifestVersion` `1`, `id` `threads`, `version` `2.2.0`, platform
  `engines.doric` `^1.10.0`, `description` "Delegation capabilities for
  creating and steering direct child threads." ([manifest.json](manifest.json)).
- Package dependencies: `bundle`, `default`, `desktop`, `lucide-react`,
  `react`, `runtime`, `tool`, `tslib`, `zod`; devDependencies `chat`, `core`,
  `happy-dom` ([package.json](package.json)).
- `provides`: none. The bundle declares no contract and has no
  `src/contracts/` module; its `package.json` exports only `./package.json`
  ([package.json](package.json)).
- `requires`:
  - `tools/v1@^1.5.0`: registers the eight tools ([src/host/index.ts](src/host/index.ts)).
  - `skills/v1@^1.3.0`: the host SDK registers the bundle's skills (see
    [Skills](#skills)).
  - `runtime.threads/v1@^1.7.0`: every tool's work on the children
    ([src/host/threads.ts](src/host/threads.ts)).
  - `ui/v1@^1.0.0`: defines the two custom elements and creates chat's
    read-only Markdown element ([src/client/index.ts](src/client/index.ts),
    [src/client/delegated-turn.tsx](src/client/delegated-turn.tsx)).
  - `navigation/v1@^1.0.0`: opens a sender's or child's conversation
    ([src/client/source.ts](src/client/source.ts)).
- `optional`:
  - `default.agents/v1`: resolves the `agent` a spawn names
    ([src/host/tools/thread-spawn.ts](src/host/tools/thread-spawn.ts)).
  - `chat.views/v1`: registers the delegated-input renderer, the projector of
    the ask rows and the `thread-spawn` drawing ([src/client/index.ts](src/client/index.ts)).
  - `runtime.records/v1`: reads a Thread's name and Project for the links
    ([src/client/source.ts](src/client/source.ts)).
- Parts: a host part (`src/host/index.ts`) and a client part
  (`src/client/index.ts`, with `src/client/styles.css`). Skills live in
  `src/skills/<name>/SKILL.md`. There is no desktop part.

## Host part

### Activation

`activate` registers each tool with `tools/v1.register(tool, { alwaysAvailable:
true, order })`, in this order and at these global model-visible orders
([src/host/index.ts](src/host/index.ts)):

| Tool               | Order |
| ------------------ | ----- |
| `thread-spawn`     | 1000  |
| `thread-list`      | 1100  |
| `thread-get`       | 1200  |
| `thread-events`    | 1300  |
| `thread-send`      | 1400  |
| `thread-interrupt` | 1500  |
| `thread-terminate` | 1600  |
| `thread-restart`   | 1650  |

It provides no service and registers no event. `tools/v1` sorts tools by
`order`, then by registration order (bundle activation order, then call order),
so a tool of another bundle at the same order sorts by that rule
([packages/bundle/src/contracts/basic/tools.ts](../../../packages/bundle/src/contracts/basic/tools.ts), [bundles/foundation/core/src/host/tools.ts](../../foundation/core/src/host/tools.ts)).

### How a tool reaches the runtime

Every tool calls `services.use(RuntimeThreadsV1, call.scope)`, so the runtime
binds each method to the prompt the tool call runs under and to the direct
children of that prompt's Thread in the same Project
([src/host/threads.ts](src/host/threads.ts)). Each tool passes `call` as the
last argument of the method it calls. The runtime rejects every method once the
prompt's binding has ended, with `Thread control is no longer active.`
([runtime contracts](../../runtime/runtime/src/contracts/threads.ts)); the
[runtime README](../../runtime/runtime/README.md) holds the full contract.

### Tools

Every input is a strict zod object: an unknown key, or a value outside the
schema, fails the call before the runtime is reached. Every output is a string.
A `prompt` must be non-empty and not only whitespace; it reaches the runtime as
written, untrimmed.

| Tool               | Input                                                                                                                              | Runtime call                                   | Output                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread-spawn`     | `{ prompt, title?, agent?, model?, effort? }`                                                                                      | `spawn(prompt, title, options, call)`          | JSON of `SpawnedThread` `{ threadId, promptId }`                                                                                                    |
| `thread-list`      | `{ limit?, cursor? }`: `limit` an integer 1–100, default 50; `cursor` a UUID                                                       | `list(limit, cursor, call)`                    | JSON of `ThreadPage` `{ items: ThreadView[], nextCursor? }`                                                                                         |
| `thread-get`       | `{ threadId }`: a UUID                                                                                                             | `get(threadId, call)`                          | JSON of `ThreadSummary` `{ thread: ThreadView, result?: { status, text, promptId, at } }`                                                           |
| `thread-events`    | `{ threadId, afterSequence?, limit? }`: `afterSequence` an integer ≥ 0, default 0 (exclusive); `limit` an integer 1–50, default 20 | `events(threadId, afterSequence, limit, call)` | JSON `{ events: [{ sequence, type, promptId, summary }], nextSequence? }`                                                                           |
| `thread-send`      | `{ threadId, prompt }`                                                                                                             | `send(threadId, prompt, call)`                 | JSON of `PromptResult`: `{ status: 'accepted', promptId }` or `{ status: 'missing' \| 'inactive' \| 'forbidden' }`                                  |
| `thread-interrupt` | `{ threadId, promptId }`: both UUIDs                                                                                               | `interrupt(threadId, promptId, call)`          | The bare `InterruptResult`, not JSON: `interrupted`, `missing`, `inactive` or `not_running`                                                         |
| `thread-terminate` | `{ threadId }`                                                                                                                     | `terminate(threadId, call)`                    | JSON of the child's `ThreadView`                                                                                                                    |
| `thread-restart`   | `{ threadId, prompt? }`                                                                                                            | `restart(threadId, prompt, call)`              | JSON of `RestartResult`: `{ status: 'accepted', promptId }` or `{ status: 'missing' \| 'inactive' \| 'not_failed' \| 'terminated' \| 'no_prompt' }` |

Sources: [thread-spawn.ts](src/host/tools/thread-spawn.ts),
[thread-list.ts](src/host/tools/thread-list.ts),
[thread-get.ts](src/host/tools/thread-get.ts),
[thread-events.ts](src/host/tools/thread-events.ts),
[thread-send.ts](src/host/tools/thread-send.ts),
[thread-interrupt.ts](src/host/tools/thread-interrupt.ts),
[thread-terminate.ts](src/host/tools/thread-terminate.ts),
[thread-restart.ts](src/host/tools/thread-restart.ts). `threadId` is a UUID in
every tool. `ThreadView` is `{ id, projectId, parentThreadId?, name, state,
lastSequence, activePromptId?, errorCode?, createdAt, updatedAt, startedAt?,
finishedAt? }`; the runtime's records may carry more keys, and the tools
serialize them unchanged ([runtime contracts](../../runtime/runtime/src/contracts/threads.ts)).

Each tool's `description`, which the model reads, is in its source file.

#### `thread-events` digest

Each event of the page becomes `{ sequence, type, promptId, summary }`. The
`summary` is the event's payload when it is a string; else its `text`, when
that is a string; else its `delta`, when that is a string; else its JSON
(`String(payload)` when it cannot be serialized). A summary longer than 400
characters is cut to its first 400 and `…` is appended. `nextSequence` is
present only when the runtime's page carries it
([src/host/tools/thread-events.ts](src/host/tools/thread-events.ts)).

#### `thread-spawn`

Input ([src/host/tools/thread-spawn.ts](src/host/tools/thread-spawn.ts)):

- `prompt`: the task, non-blank.
- `title`: optional, non-blank; no length limit is enforced. The runtime
  names the child after it, else after the start of `prompt`.
- `agent`: optional, matching `agentNamePattern` of `default/contracts`
  (`/^[a-z0-9][a-z0-9_-]{0,63}$/u`).
- `model`: optional, a non-empty string.
- `effort`: optional, one of `none`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max` (`reasoningEfforts` of `runtime/contracts`).

Behavior:

1. When `agent` is given, the tool calls `default.agents/v1.resolve({ name },
call)` in the call's scope. When no provider serves `default.agents/v1`
   (a `ContractError` coded `unavailable` whose `details.contract` is
   `default.agents/v1`), the call fails with `Agent types are unavailable in
this runtime.` Every other error of `resolve`, such as `not_found` or
   `invalid_definition`, fails the call unchanged.
2. The model is the input's `model`, else the agent definition's `model`; the
   effort is the input's `effort`, else the definition's `effort`.
3. When there is no agent, no model and no effort, the tool passes no options.
   Otherwise it passes `SpawnOptions` `{ agent?: { name, source, instructions },
model?, effort? }`, with only the fields it has.
4. It calls `runtime.threads/v1.spawn(prompt, title, options, call)` and
   answers the JSON of the result.
5. When the spawn rejects with a `ContractError` coded `invalid_execution`
   whose `details.issue` is `model`, the input named no model and the model
   came from the agent's definition, the call fails with `Agent "<name>" names
model "<model>", which its parent thread's provider does not list. <the
runtime's message>`. Every other rejection fails the call unchanged.

The runtime checks the model and effort against the parent's provider and
`models/v1`, and creates nothing when it refuses them; the
[runtime README](../../runtime/runtime/README.md) and
[Per-thread model](../../../docs/features/per-thread-model.md) hold those rules.

### Skills

Each skill is a `SKILL.md` whose frontmatter gives `name`, `description` and
`order`; the build checks each one and copies it into the built bundle
([packages/bundle/src/build/cli.ts](../../../packages/bundle/src/build/cli.ts),
[packages/bundle/src/loader/skills.ts](../../../packages/bundle/src/loader/skills.ts));
the host SDK registers them from the bundle's own process after `activate` (`registerBundleSkills`, [packages/bundle/src/sdk/host/skills.ts](../../../packages/bundle/src/sdk/host/skills.ts)), reading them through `context.assets`, so `host.assets` lists `src/skills/*/SKILL.md`; a skill that cannot be registered is skipped and logged (`skill not registered`). `allowed-tools` is a run-time reference for the model: `skills/v1` 1.3.0 stores it as given and does not check it against `tools/v1`.

| Skill               | Order | Always available | Purpose                                                                  |
| ------------------- | ----- | ---------------- | ------------------------------------------------------------------------ |
| `thread-delegation` | 3100  | yes              | Delegate self-contained work to a child and keep working while it runs.  |
| `thread-inspection` | 3200  | no               | Observe children through their state and events without disturbing them. |
| `thread-steering`   | 3300  | no               | Redirect or close children with the narrowest control.                   |

Sources: [thread-delegation](src/skills/thread-delegation/SKILL.md),
[thread-inspection](src/skills/thread-inspection/SKILL.md),
[thread-steering](src/skills/thread-steering/SKILL.md). None sets
`allowed-tools`.

### Process entry

The bundle also has a process entry, [`src/host/main.ts`](src/host/main.ts),
for the bundle-process runtime
([bundle processes](../../../docs/features/bundle-processes.md)). It registers
the same eight tools over routed `runtime.threads/v1` and the optional
`default.agents/v1` ([src/host/routed.ts](src/host/routed.ts)). Any
`unavailable` from the agent lookup answers "Agent types are unavailable in
this runtime."

## Client part

### Activation

`activate` ([src/client/index.ts](src/client/index.ts)):

1. Defines `<threads-delegated-turn>` and `<threads-spawn-call>` through
   `ui/v1.define`.
2. While `runtime.records/v1` is available, follows it as the records source;
   when it leaves, the source is cleared.
3. While `chat.views/v1` is available, registers `<threads-delegated-turn>` as
   the renderer of the block type `chat.delegated-input/v1`, then registers the
   ask-row projector. When the projector registration throws (another bundle
   claimed those event types), the renderer stays and the other projection
   stands.
4. While `chat.views/v1` is available, in a separate callback, registers the
   tool renderer `{ toolName: 'thread-spawn', elementTag: 'threads-spawn-call',
standalone: true }`, so each call is a block of its own outside the activity
   group. A refusal of this registration leaves the delegated-input renderer in
   place.
5. Returns a cleanup that disposes every registration and both element
   definitions.

Without `chat.views/v1`, the elements are defined and nothing is registered:
the chat draws delegated inputs itself and draws a `thread-spawn` call as its
generic tool row.

### Contracts reached by structural copy

The client does not import `chat/contracts`. It keeps a structural copy of the
part of `chat.views/v1` it uses (`registerRenderer`, `registerProjector`,
`registerToolRenderer`, `ChatToolView`, `ProjectorSpec`, the event name
`chat-block-chosen` and the block type `chat.delegated-input/v1`) and builds
`ChatViewsV1` from the id with `ref` ([src/client/chat-contract.ts](src/client/chat-contract.ts)).
It builds `RuntimeRecordsV1` from the id `runtime.records/v1` the same way,
typed as the `thread` and `subscribe` methods of `RuntimeRecords`
([src/client/source.ts](src/client/source.ts)). The
[chat README](../../desktop/chat/README.md) holds the full `chat.views/v1`.

### Sender and child names

`useDelegatedSource(threadId, services)` reads the Thread from the records
source synchronously and re-renders when the records change
([src/client/source.ts](src/client/source.ts)):

- Label: the Thread's `name` when the records hold it and it is not blank;
  else the first eight characters of `threadId`
  ([src/client/domain/delegated.ts](src/client/domain/delegated.ts)).
- Open: when the records hold the Thread, a function that calls
  `navigation/v1.navigate('/projects/<projectId>/threads/<threadId>')`, each
  id URI-encoded; else none.
- A records method that throws reads as an unknown Thread. A records source
  whose `subscribe` throws is still read on each render, but its changes do
  not re-render the block.

### `<threads-delegated-turn>`

Chat sets `block` (`{ type: 'chat.delegated-input/v1', id, data: { promptId,
input } }`) and `focused`, calls `toggle()` and reads `chosen`
([src/client/delegated-turn.tsx](src/client/delegated-turn.tsx),
[src/client/chat-contract.ts](src/client/chat-contract.ts)).

- `input` is a `DelegatedInput` `{ kind: 'parent' | 'result', threadId,
status?, text }`. A block whose input lacks a valid `kind`, a string
  `threadId` or a string `text` draws nothing.
- It draws `desktop/ui/collapsible-block`. The header reads `Instruction from:`
  for `parent`, preceded by an agent icon, or `Result from:` for `result`,
  followed by the sender's label: a link that opens the sender's conversation
  when the records hold the Thread, else plain text, in monospace when it is
  the short id. The label's tooltip is the full
  `threadId`, and its click does not toggle the block.
- The body shows `Status: <status>` when `status` is present, then `text`
  through chat's `<chat-readonly-markdown>`, created with `ui/v1.create` and
  disposed with `ui/v1.dispose`. When that element cannot be created, it logs
  `Doric: <chat-readonly-markdown> could not be created:` with the error and
  draws no text.
- An instruction starts open and a result starts closed. The element keeps the
  reader's choice in memory: `toggle()` sets it to the opposite of `chosen`,
  and the choice then stands.

### `<threads-spawn-call>`

Chat creates one element per `thread-spawn` call and sets `view`, a
`ChatToolView` `{ projectId, threadId, promptId, key, name, args, result?,
error?, status: 'running' | 'finished' | 'failed', chosen: boolean | null,
focused }` ([src/client/spawn-call.tsx](src/client/spawn-call.tsx),
[src/client/chat-contract.ts](src/client/chat-contract.ts)).

- Parsing ([src/client/domain/thread-spawn.ts](src/client/domain/thread-spawn.ts)):
  `args` and `result` are JSON strings. The prompt is `args.prompt` when it is
  a string, else the raw `args` text. `agent`, `model` and `effort` are the
  trimmed strings of `args`, absent when not a non-empty string. The child is
  `{ threadId, promptId }` only when `result` parses to an object with both as
  non-empty strings. Malformed JSON never throws.
- Header: `Spawning` while `running`, `Spawned` when `finished`, `Spawn failed`
  when `failed`. Once the child is known, the header names it with a
  link-styled button (label as in
  [Sender and child names](#sender-and-child-names), never monospace; tooltip
  the full `threadId`). The button opens the child's conversation when the
  records hold the Thread and does nothing otherwise.
  The agent, model and effort that are present follow, muted, as
  `· <agent> · <model> · <effort>`: after the child once there is one, after
  the verb until then.
- Body: the prompt through `<chat-readonly-markdown>`; when `error` is
  present, a compact `desktop/ui/error-notice` with the catalog
  `threadsToolCatalog` (`tool_failed`: title `Tool failed`, not retryable),
  fallback code `tool_failed` and the context `{ Tool: 'thread-spawn' }`.
- Open state: the block follows `view.chosen` when the reader has chosen;
  otherwise it is open while `running` and when `failed`, and closed when
  `finished`. The element keeps no state: a reader's open or close, and
  `toggle()`, dispatch `chat-block-chosen` with `detail: { chosen }`
  (bubbling, composed), and `toggle()` reports the opposite of what the block
  shows by that rule. A missing `view` draws nothing.

### Ask rows

A Thread's log can hold rows of the event types `threads.asked/v1` and
`threads.answered/v1`. The client's projector claims both and answers no block
for them, so such a log replays without a block and without chat's fallback for
an unknown event ([src/client/old-asks.ts](src/client/old-asks.ts)).

### Styles

`src/client/styles.css` imports the Tailwind utilities over
`desktop/ui/tailwind.css` and scans `src/client/`,
`packages/desktop/src`, and the client sources of the `layout`, `chat`,
`settings`, `account` and `workspace` bundles, so that its sheet holds the
whole sorted set of utilities the window uses
([src/client/styles.css](src/client/styles.css)).

## Data and persistence

The bundle stores nothing. Children, their events and results are the
runtime's; the bundle reads and changes them only through
`runtime.threads/v1`. The open state of a delegated-input block lives in its
element's memory; the open state of a spawn block is kept by chat in
`view.chosen`. The records source is module state of the client part.

## Configuration and limits

- No setting and no configuration key.
- `thread-list`: `limit` 1–100, default 50. `thread-events`: `limit` 1–50,
  default 20, and a summary of at most 400 characters plus `…`.
- `agent` names match `/^[a-z0-9][a-z0-9_-]{0,63}$/u`.

## Errors

- An input the schema refuses fails the call before any runtime call.
- `thread-spawn`: `Agent types are unavailable in this runtime.` without a
  provider of `default.agents/v1`; the agent-model message of step 5 above;
  every other error of `default.agents/v1` or the runtime unchanged.
- Every other tool fails with the runtime's rejection unchanged, including
  `Thread control is no longer active.` once the calling prompt's binding has
  ended.
- In the client, a failing records read reads as an unknown Thread, a refused
  projector or tool-renderer registration leaves the other registrations in
  place, and a missing `<chat-readonly-markdown>` is logged and draws no text.

## Build and test

Run from the repository root ([project.json](project.json)):

```console
npx nx run bundle-threads:typecheck
npx nx run bundle-threads:test
npx nx run bundle-threads:build
```

- `typecheck` checks `tsconfig.json` (the `.ts` files of `src/` outside
  `src/client/`, declarations only) and `tsconfig.client.json` (the `.ts` and
  `.tsx` files of `src/client/`, `stories/` and `.storybook/`, without
  emitting).
- `build` compiles `src/` outside `src/client/` into `dist/`, type-checks the
  client with `tsconfig.client.json`, then runs the bundle CLI. The CLI
  validates the manifest and each skill, copies the skills, builds the client
  part, dry-activates the parts, and writes the JSON Schemas, `contracts.json`
  and `package.json` into `dist/`
  ([packages/bundle/src/build/cli.ts](../../../packages/bundle/src/build/cli.ts)).
  `doric-host:build-bundles` stages every bundle, this one into
  `app/backend/doric-host/dist/bundles/threads`.
- `test` builds first, compiles into `dist-tests/` the host part,
  `src/client/domain/`, `src/client/old-asks.ts` and `tests/*.ts`
  (`tsconfig.spec.json`) and `tests/client/` (`tsconfig.client-spec.json`),
  and runs
  `dist-tests/tests/*.test.js` and `dist-tests/tests/client/*.test.js` with
  `node --test`. `tests/*.test.ts` cover the host tools, the manifest, the
  parsing helpers, the ask-row projector and the stylesheet's `@source`
  lines; `tests/client/*.test.ts` mount the elements in `happy-dom`.
- `stories/` holds the stories of `DelegatedTurn`.
