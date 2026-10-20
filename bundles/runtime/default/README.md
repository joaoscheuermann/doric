# Default bundle

`default` is the default agent: the agent loop behind every Doric
conversation. It was named `direct` until 2026-10-19. It runs one prompt
of a Thread: it builds the system prompt from the enabled skills, offers the
model every registered tool, calls the configured model, saves the history as
it goes, and compacts a long conversation so the agent can keep working
within the model's context window.

It provides `executor/v1`, the default executor, and owns `default.hooks/v1`. The bundle runs in the
generation process next to `runtime`, which calls it. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

`executor/v1@1.2.0`, with:

- `run` — run one prompt of a Thread;
- `checkpoint` and `rewind` — give the runtime the history patch it commits;
- `formats` — the history formats it reads (`default.history/v1`, and
  `direct.history/v1` written before the rename);
- `compact` — condense an idle Thread's history on demand.

`default.hooks/v1@1.0.0`, an extension point for other bundles (the
`default` bundle registers no handler of its own), with:

- `onBeforeModelRequestHook` (`transform`, input `{ system }`) — runs before
  every model request of a prompt, under the prompt's call (`call.scope` names
  the prompt and `call.signal` aborts with it), so a handler can adjust the
  system prompt to the Thread's state at that turn. Each handler receives the
  previous one's output; a failing handler is skipped. A bundle registers
  through `hooks/v1` with `default.hooks/v1` in its `requires`:

  ```ts
  services
    .use(HooksV1)
    .use(DefaultHooksV1)
    .onBeforeModelRequestHook(({ system }) => ({
      system: `${system}\n\n# Project rules\n\nUse tabs.`,
    }));
  ```

## Behavior

- **System prompt:** the default instruction followed by every skill that
  `skills/v1` lists, in that order (the global `order` key, then
  bundle order), passed through `onBeforeModelRequestHook` before every model
  request.
- **Working in code:** the instruction tells the agent to work at a
  repository's root, to initialize a repository for a complex deliverable that
  has none, and to ask the user first when the code is an experiment.
- **Coding in a repository:** the coding workflow
  (`src/host/prompts/repository.ts`) reaches the agent as a standing
  instruction, not as system prompt text, once per Thread. The bundle calls
  `runtime.threads/v1.instruct` (reason `coding-workflow`, `retain: true`):
  - when a task — the reader's request or a parent's delegated step — starts
    while the Thread's `cwdRepo` hint is set: the executor checks before the
    run's first model request;
  - when a running prompt moves into a repository root, after the tool batch
    that moved it: the `onThreadCwdChangedHook` handler checks the run;

  and in both cases only while the history the model reads does not hold it
  (`meta.retained`), so a later task, or a move between repositories, gives
  nothing again, and a rewind that removed it gives it once more.

  The workflow runs Search, Plan, Development (Contracts, then red Tests, then
  green Implementation) and Cleanup, each subagent type with its goal, tools,
  the files it may change and what it returns; Contracts generates the
  contracts as its result and changes no file. The main Thread delegates each
  step to a child Thread whose title and first instruction line name its type
  (`Search: …`, `Type: Search`), except for trivial changes; a child does its
  delegated step itself. Both runtime contracts are `optional`, because the
  runtime requires `executor/v1`.

- **Input envelope:** every input is framed in XML, not Markdown headers:
  `<user-request>`, `<parent-instruction thread="" prompt="">`,
  `<terminal-output terminal="" prompt="">`,
  `<child-result thread="" prompt="">` or
  `<bundle-instruction bundle="" reason="">`. Attribute values escape `&`, `"`
  and `<`; a closing tag of those five names inside the body becomes `<\/…`. Older
  history keeps its `# User request` text. The system prompt describes the
  envelope, the chat's `<comments>`, `<target>`, `<comment>` and `<message>`
  parts, and the `comment_reply` tool.
- **Tools:** every tool `tools/v1` lists, bound to the prompt's call.
  A prompt whose tool settings are unmet is refused before the model is called.
- **Model:** the configured execution provider, model and effort, read from
  `host-config/v1` and resolved through `models/v1`.
- **History:** stored as `default.history/v1` in two parts, `messages` and
  `meta` (turn boundaries, message count, and `retained`: the index of each
  standing instruction by `<bundleId>:<reason>`, recorded when the run stores a
  retained bundle steer). A Thread written as
  `direct.history/v1` holds the same parts; it is read as is and rewritten in
  the new format on its next save. The executor saves it on
  `response.finished`, on `tool.finished` and when the run ends.
- **Checkpoint and rewind:** `checkpoint` and `rewind` give the runtime the
  history patch it commits.
- **Compaction:** when the configuration's `contextCompaction` section is
  enabled, a run measures context pressure before its first provider call
  and between turns, and condenses older history into one summary when it
  passes the configured line; `compact` does the same on demand. The rewrite
  keeps an assistant tool call with its result, and keeps every retained
  message of the condensed span verbatim right after the summary, out of the
  summarizer's input, with its index re-based like the turn boundaries; a
  rewind forgets the retained messages past its boundary.
- **Writes:** every history and event write goes through the runtime's
  `PromptSession`, which redacts, persists, publishes and keeps the retry.

## Tests

`npx nx test bundle-default` runs the ported executor scenarios against fake
`host-config/v1`, `models/v1`, `tools/v1`, `skills/v1`, `hooks/v1` and
`runtime.threads/v1` providers and a fake prompt session, and the coding
workflow's instruction policy through the runtime hooks it observes. It also runs the exact request-body checks: the real `llms`
OpenRouter and OpenAI Responses providers, with a faked HTTP transport, must
send the bodies the stage-1 host recorded (`tests/fixtures/request-body`).

## Development

```console
npx nx build bundle-default
npx nx typecheck bundle-default
npx nx test bundle-default
```

The build writes `bundles/runtime/default/dist`. To rebuild and stage every
bundle used by the Doric host:

```console
npx nx run doric-host:build-bundles
```
