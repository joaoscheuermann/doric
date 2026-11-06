# Threads bundle

`threads` lets one Doric agent run a team: it can split a large task into
child threads, hand each one a self-contained job, check on their progress,
steer or stop them, and collect their results. Every child is a normal
conversation you can open, read and redirect in the desktop app.

Asking the user is not here: since `threads` 2.0.0 the agent asks with a
question form in an `openui-lang` fence, drawn by the
[`openui`](../openui/README.md) bundle.

It is a feature bundle with a host part (the delegation tools) and a client
part (how delegated messages appear in chat),
loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tools:** eight always-available delegation tools.
- **Skills:** delegating, inspecting and steering child threads.
- **UI:** `<threads-delegated-turn>`, the chat renderer for another Thread's
  instruction or result.
- **Contracts:** none (bundle 2.0.0 removed `threads.ask/v1` and the events
  `threads.asked/v1` and `threads.answered/v1`).

## Tools

The tools take global model-visible positions 1000 to 1650. The delegation
tools act only on the calling prompt's direct child threads in the same
project, in this order:

- `thread-spawn` — create a child chat, optionally titled (up to 80
  characters; without a title it is named after the start of its prompt), and
  delegate a self-contained task. It returns immediately, and the child's
  result arrives in the parent's chat. `agent` runs the child as one of the
  agents `default.agents/v1` defines, with that agent's instructions; `model`
  and `effort` override the agent's defaults, and without them the child runs
  on the agent's, else on the parent's. A model or effort is checked against
  the models the configured execution provider lists (a provider without a
  list accepts any) and then resolved through `models/v1`, so an invalid one
  fails the call before any child is created;
- `thread-list`, `thread-get` — observe a direct child's state and, once a
  prompt has finished, its materialized result;
- `thread-events` — read a bounded, digested page of a child's persisted
  events;
- `thread-send` — queue a follow-up instruction in a child;
- `thread-restart` (position 1650) — reopen a direct child whose thread itself
  failed, in place, and queue a prompt in it: the one it is given, or the last
  prompt the child accepted;
- `thread-interrupt`, `thread-terminate` — cancel one active prompt or close a
  child subtree.

A child shares the Project's workspace but has its own history. Each tool
reaches the calling prompt's children through `runtime.threads/v1`
(`runtime/contracts`), scoped by the prompt `Call` it runs under, and returns
the serialized result. The bundle never imports `app/backend/doric-host`
internals: it requires `runtime.threads/v1@^1.6.0`, `models/v1@^1.0.0` and
`host-config/v1@^1.1.0` beside `tools/v1`, `ui/v1` and `navigation/v1`, and optionally `default.agents/v1`: without a
provider, `thread-spawn` fails a call that names an agent with "Agent types are
unavailable in this runtime." and spawns every other one.

## Skills

- `thread-delegation` — delegate self-contained work and keep working while
  children run, choosing each child's agent, model and effort; always
  available.
- `thread-inspection` — observe children through their durable events without
  disturbing them.
- `thread-steering` — redirect or close children with the narrowest effective
  control.

Skills live in `src/skills/<name>/SKILL.md`; each one's `order` frontmatter
(3100 to 3300) sets its global position in the system prompt.

## Client part

`src/client` draws another Thread's input in a conversation (a delegated
instruction or result) as `<threads-delegated-turn>`, registered as chat's
renderer for `chat.delegated-input/v1` when `chat.views/v1` is available. It
shows `Instruction from:` or `Result from:`, the sender (its name from
`layout.workspace/v1` when the tree knows it, as a link to its conversation,
else its short id), `Status: …` and the text through chat's
`<chat-readonly-markdown>`. An instruction starts open and a result closed.

Threads written before 2.0.0 still hold `threads.asked/v1` and
`threads.answered/v1` rows. When `chat.views/v1` is available the client
registers a projector that claims both and draws nothing, so they replay
without a block.

## Change the bundle

1. Update a tool in `src/host/tools/<name>.ts` or add a skill at
   `src/skills/<name>/SKILL.md`; tools are registered in order in
   `src/host/index.ts`.
2. Reach the runtime only through contracts declared in `manifest.json`
   `requires`.
3. A skill's `allowed-tools` resolve against the whole `tools/v1` catalog.
4. Build and test; the build validates the manifest and skills and
   dry-activates the host part.

## Development

```console
npx nx build bundle-threads
npx nx typecheck bundle-threads
npx nx test bundle-threads
```

The build writes `bundles/features/threads/dist`, which
`doric-host:build-bundles` stages into
`app/backend/doric-host/dist/bundles/threads`; the Doric host loads it through
the `bundle` loader. To rebuild and stage every bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
