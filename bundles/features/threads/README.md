# Threads bundle

`threads` lets one Doric agent run a team: it can split a large task into
child threads, hand each one a self-contained job, check on their progress,
steer or stop them, and collect their results. Every child is a normal
conversation you can open, read and redirect in the desktop app.

It also lets the main agent ask the user multiple-choice questions and take
the answers back as the user's next input.

It is a feature bundle with a host part (the delegation tools, the `ask` tool
and its service) and a client part (how delegated messages appear in chat),
loaded by the `bundle` platform.
See the [main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

- **Tools:** nine always-available tools: eight delegation tools and `ask`.
- **Skills:** delegating, inspecting and steering child threads.
- **UI:** `<threads-delegated-turn>`, the chat renderer for another Thread's
  instruction or result, and `<threads-ask>`, the chat's question block for an
  ask.
- **Contracts** (`threads/contracts`, bundle 1.1.0): the host service
  `threads.ask/v1@1.1.0` and the events `threads.asked/v1@1.0.0` and
  `threads.answered/v1@1.0.0`.

## Tools

The tools take global model-visible positions 1000 to 1660. The delegation
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

They are followed by `ask` (position 1660), described under
[Asking the user](#asking-the-user).

A child shares the Project's workspace but has its own history. Each tool
reaches the calling prompt's children through `runtime.threads/v1`
(`runtime/contracts`), scoped by the prompt `Call` it runs under, and returns
the serialized result. The bundle never imports `app/backend/doric-host`
internals: it requires `runtime.threads/v1@^1.6.0`, `events/v1@^1.0.0`,
`models/v1@^1.0.0` and `host-config/v1@^1.1.0` beside `tools/v1`, `hooks/v1`,
`ui/v1` and `navigation/v1`, and optionally `default.agents/v1`: without a
provider, `thread-spawn` fails a call that names an agent with "Agent types are
unavailable in this runtime." and spawns every other one.

## Asking the user

`ask` puts one to five multiple-choice questions to the user. Each question
has a unique `id`, the `question` text and two to six options with unique
labels (an option may have a `description` and be `recommended`);
`multiSelect` defaults to false and `allowOther` (a free answer) to true. An
optional `context` is shown above the questions. On the main Thread the tool
records `threads.asked/v1` with an `askId` the host generates and returns a
text telling the model to end its turn: the answers arrive as the next user
input. A new ask supersedes any unanswered one of the Thread. In an agent
Thread (`origin` `agent`) it records nothing and returns a refusal telling
the agent to put the question in its result.

`threads.ask/v1` (host, both methods exposed to the desktop, `desktopScope`
`projectId`, `threadId`, `promptId`) keeps no state of its own. Every call
reads the call's Thread log through `runtime.threads/v1.threadEvents` and
folds its `threads.asked/v1` and `threads.answered/v1` rows again, so the
state survives a host restart. An askId the Thread's log does not hold is
`not_found`, and a call scope missing a key the method needs is
`invalid_scope`.

- `status({ askId })` returns `pending`, `answered` with its answers (the
  first answer wins) or `superseded` (a later ask exists and this one was
  never answered); answered takes precedence over superseded, superseded over
  pending.
- `answer({ askId, answers })` returns the state of an answered or superseded
  ask without sending anything. Otherwise the answers must give each recorded
  question exactly one answer that names only its labels, each once, at most
  one on a single-select question, and `other` only where `allowOther` is not
  false; anything else is `invalid_input`. A question may be skipped: an
  answer with no label and no non-blank `other` (`{ "id": …, "options": [] }`).
  The answers then reach the Thread as one user input through
  `runtime.threads/v1.steer`: into the running prompt, else into the ask's own
  prompt, which the runtime queues and runs at once when the Thread is idle.
  Only then is `threads.answered/v1` recorded and `answered` returned. A
  refused or failed send is `unavailable` and records nothing, so the ask
  stays pending. Calls for the same askId run one at a time.

The input the Thread receives lists each question in order with the chosen
labels, in option order, then the trimmed free answer, joined with `; `, and
`(skipped)` for a skipped question:

```text
Answers to your questions:

1. Which database should the service use?
   PostgreSQL; keep the current schema
2. Approve the migration plan?
   Yes
3. Which regions get it first?
   (skipped)
```

In the chat, the ask is an interactive block (`<threads-ask>`, see
[Client part](#client-part)): one question at a time, its options as numbered
rows and a free answer row unless `allowOther` is `false`, then Send. Back,
Next and Send are always enabled (Send only waits while sending): a question
left empty is skipped. Keys typed in the block stay in it and never reach the
chat editor. Once answered it shows each question with its answer, or
"Skipped"; a later ask marks it superseded.

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

It also draws each ask. When `chat.views/v1` is available it registers a
projector that claims `threads.asked/v1` and `threads.answered/v1` (so neither
becomes a generic block) and turns each asked row into one
`threads.question/v1` block, drawn by `<threads-ask>`. The block reads the
ask's state with `threads.ask/v1.status` on mount, in the scope of the asked
row (its Project, Thread and prompt), and reads it again on each live row that
can change it — the ask's answer or a later ask — which it receives through
`chat.hooks/v1`'s `onThreadUpdateHook` (reached with `hooks/v1`). Send calls
`threads.ask/v1.answer` from the window in the same scope and shows the
answers it returns; a refused send keeps the picks and offers Send again.

## Change the bundle

1. Update a tool in `src/host/tools/<name>.ts` or add a skill at
   `src/skills/<name>/SKILL.md`; tools are registered in order in
   `src/host/index.ts`, with the `threads.ask/v1` service and its two events.
   The contracts live in `src/contracts/index.ts`.
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
