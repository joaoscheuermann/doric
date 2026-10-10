# Direct bundle

`direct` provides `executor/v1`, the Direct executor that runs one prompt of a
Thread. Its build writes `bundles/direct/dist`. The bundle runs in the
generation process, next to `runtime`, which calls it.

## Behavior

- **System prompt:** the Direct instruction followed by every skill that
  `skills/v1` lists, in bundle order.
- **Tools:** every tool `tools/v1` lists, bound to the prompt's call.
  A prompt whose tool settings are unmet is refused before the model is called.
- **Model:** the configured execution provider, model and effort, read from
  `host-config/v1` and resolved through `models/v1`.
- **History:** stored as `direct.history/v1` in two parts, `messages` and `meta`
  (turn boundaries and message count). The executor saves it on
  `response.finished`, on `tool.finished` and when the run ends.
- **Checkpoint and rewind:** `checkpoint` and `rewind` give the runtime the
  history patch it commits.
- **Writes:** every history and event write goes through the runtime's
  `PromptSession`, which redacts, persists, publishes and keeps the retry.

## Tests

`npx nx test bundle-direct` runs the ported Direct scenarios against fake
`host-config/v1`, `models/v1`, `tools/v1` and `skills/v1` providers and a fake
prompt session. It also runs the exact request-body checks: the real `llms`
OpenRouter and OpenAI Responses providers, with a faked HTTP transport, must
send the bodies the stage-1 host recorded (`tests/fixtures/request-body`).
