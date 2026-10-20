# Threads bundle

`threads` lets one Doric agent run a team: it can split a large task into
child threads, hand each one a self-contained job, check on their progress,
steer or stop them, and collect their results. Every child is a normal
conversation you can open, read and redirect in the desktop app.

It is a feature bundle with a host part (the delegation tools) and a client
part (how delegated messages appear in chat), loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tools:** eight always-available delegation tools.
- **Skills:** delegating, inspecting and steering child threads.
- **UI:** `<threads-delegated-turn>`, the chat renderer for another Thread's
  instruction or result.

The bundle provides no contract of its own.

## Tools

The tools act only on the calling prompt's direct child threads in the same
project, and take global model-visible positions 1000 to 1650 in this order:

- `thread-spawn` — create a child chat, optionally titled (up to 80
  characters; without a title it is named after the start of its prompt), and
  delegate a self-contained task. It returns immediately, and the child's
  result arrives in the parent's chat;
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
internals.

## Skills

- `thread-delegation` — delegate self-contained work and keep working while
  children run; always available.
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
