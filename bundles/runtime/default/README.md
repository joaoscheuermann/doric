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

`default.hooks/v1@1.0.0`, with:

- `onBeforeModelRequestHook` (`transform`, input `{ system }`) — runs before
  every model request of a prompt, under the prompt's call, so a handler can
  adjust the system prompt to the Thread's state at that turn. A bundle
  registers through `hooks/v1` with `default.hooks/v1` in its `requires`.

## Behavior

- **System prompt:** the default instruction followed by every skill that
  `skills/v1` lists, in that order (the global `order` key, then
  bundle order), passed through `onBeforeModelRequestHook` before every model
  request.
- **Working in code:** the instruction tells the agent to work at a
  repository's root, to initialize a repository for a complex deliverable that
  has none, and to ask the user first when the code is an experiment.
- **Coding in a repository:** the bundle's own `onBeforeModelRequestHook`
  handler appends the coding workflow (`src/host/prompts/repository.ts`) while
  the Thread's record carries a `cwdRepo` hint, which the runtime sets when its
  working directory is a repository root. The workflow runs Search, Plan,
  Development (contracts, red tests, green implementation) and Cleanup; the
  main Thread delegates each step to a child Thread with a self-contained
  prompt, except for trivial changes, and a child does its delegated step
  itself. The hint is read through `runtime.threads/v1`, an `optional`
  contract because the runtime requires `executor/v1`.
- **Input envelope:** every input is framed in XML, not Markdown headers:
  `<user-request>`, `<parent-instruction thread="" prompt="">`,
  `<terminal-output terminal="" prompt="">` or
  `<child-result thread="" prompt="">`. Attribute values escape `&`, `"` and
  `<`; a closing tag of those four names inside the body becomes `<\/…`. Older
  history keeps its `# User request` text. The system prompt describes the
  envelope, the chat's `<comments>`, `<target>`, `<comment>` and `<message>`
  parts, and the `comment_reply` tool.
- **Tools:** every tool `tools/v1` lists, bound to the prompt's call.
  A prompt whose tool settings are unmet is refused before the model is called.
- **Model:** the configured execution provider, model and effort, read from
  `host-config/v1` and resolved through `models/v1`.
- **History:** stored as `default.history/v1` in two parts, `messages` and
  `meta` (turn boundaries and message count). A Thread written as
  `direct.history/v1` holds the same parts; it is read as is and rewritten in
  the new format on its next save. The executor saves it on
  `response.finished`, on `tool.finished` and when the run ends.
- **Checkpoint and rewind:** `checkpoint` and `rewind` give the runtime the
  history patch it commits.
- **Compaction:** when the configuration's `contextCompaction` section is
  enabled, a run measures context pressure before its first provider call
  and between turns, and condenses older history into one summary when it
  passes the configured line; `compact` does the same on demand. The rewrite
  keeps an assistant tool call with its result.
- **Writes:** every history and event write goes through the runtime's
  `PromptSession`, which redacts, persists, publishes and keeps the retry.

## Tests

`npx nx test bundle-default` runs the ported executor scenarios against fake
`host-config/v1`, `models/v1`, `tools/v1`, `skills/v1`, `hooks/v1` and
`runtime.threads/v1` providers and a fake prompt session. It also runs the exact request-body checks: the real `llms`
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
