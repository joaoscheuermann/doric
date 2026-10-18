# Direct bundle

`direct` is the agent loop behind every Doric conversation. It runs one prompt
of a Thread: it builds the system prompt from the enabled skills, offers the
model every registered tool, calls the configured model, saves the history as
it goes, and compacts a long conversation so the agent can keep working
within the model's context window.

It provides `executor/v1`, the Direct executor. The bundle runs in the
generation process next to `runtime`, which calls it. See the
[main README](../../../README.md) for Doric as a whole and
[`packages/bundle`](../../../packages/bundle/README.md) for how bundles work.

## What it provides

`executor/v1@1.1.0`, with:

- `run` — run one prompt of a Thread;
- `checkpoint` and `rewind` — give the runtime the history patch it commits;
- `formats` — the history formats it reads (`direct.history/v1`);
- `compact` — condense an idle Thread's history on demand.

## Behavior

- **System prompt:** the Direct instruction followed by every skill that
  `skills/v1` lists, in that order (the global `order` key, then
  bundle order).
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
- **History:** stored as `direct.history/v1` in two parts, `messages` and `meta`
  (turn boundaries and message count). The executor saves it on
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

`npx nx test bundle-direct` runs the ported Direct scenarios against fake
`host-config/v1`, `models/v1`, `tools/v1` and `skills/v1` providers and a fake
prompt session. It also runs the exact request-body checks: the real `llms`
OpenRouter and OpenAI Responses providers, with a faked HTTP transport, must
send the bodies the stage-1 host recorded (`tests/fixtures/request-body`).

## Development

```console
npx nx build bundle-direct
npx nx typecheck bundle-direct
npx nx test bundle-direct
```

The build writes `bundles/runtime/direct/dist`. To rebuild and stage every
bundle used by the Direct host:

```console
npx nx run doric-host:build-bundles
```
