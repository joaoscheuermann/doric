# OpenRouter model compatibility

Research checked on 2026-08-08. This is a transport and behavioral contract,
not a claim that every model from a laboratory supports every feature.
OpenRouter's live `supported_parameters` for the selected model is authoritative
for routing; the laboratory profile supplies only known behavioral constraints
and a conservative fallback when discovery is unavailable.

## Normalized contract

`createOpenRouterProvider` keeps the public `LlmProvider` request and response
types while using OpenRouter Chat Completions underneath.

- Tool requests map `toolChoice`, advertised `parallelToolCalls`,
  strict-compatible tool schemas, assistant tool calls, tool results, and
  opaque `reasoning_details`.
- `parallelToolCalls` is sent only when the live model catalog advertises
  `parallel_tool_calls`; otherwise it is omitted so parameter-required routing
  can still select a tool-capable endpoint. `false` always adds a short
  model-facing instruction to call at most one tool in that response. Agent
  runs still validate an entire tool batch atomically before any handler runs.
- Direct tool-free structured output selects `json_schema`, then `json_object`,
  then a JSON Schema system instruction from live capabilities. Every result is
  parsed with JSON and validated with the original Zod schema; invalid output
  receives at most two local correction attempts.
- Direct structured streams are atomic: the provider buffers and validates the
  completion before emitting its text and `response.finished` event.
- Tools plus direct `schema` fail explicitly. Tool-enabled structured Agent runs
  use the reserved terminal tool contract instead.
- Native parameters use OpenRouter `provider.require_parameters: true`. A
  feature that cannot be emulated fails before completion; it is never silently
  downgraded.
- The adapter never writes raw tokenizer control tokens into an OpenRouter
  prompt. OpenRouter/inference endpoints own the model chat template.

## Laboratory divergences

| Laboratory / family       | Documented divergence                                                                                                                                 | OpenRouter behavior                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                    | Strict functions and JSON schemas require a supported schema subset; stateless reasoning models require opaque output/reasoning items to be replayed. | Marks only already-compatible schemas strict and replays ordered opaque items.                                                                                               |
| Anthropic Claude          | Forced `any`/named tools are incompatible with manual extended thinking; strict tool use and JSON output have distinct controls.                      | Downgrades forced choice to `auto` where the model refuses it; replays its own signed thinking blocks.                                                                       |
| Google Gemini             | Function calls may be parallel or sequential. Thought signatures must be returned exactly in their original parts during function calling.            | Replays ordered `reasoning_details`; sequential mode is reinforced and validated.                                                                                            |
| Google Gemma              | Raw deployments use version-specific tool/control tokens and thought retention rules.                                                                 | Relies on the endpoint chat template, uses conservative choice controls, and replays only tool turns.                                                                        |
| DeepSeek                  | JSON mode can return empty content; reasoning/tool responses expose provider-specific reasoning state.                                                | Validates locally, repairs boundedly, and preserves OpenRouter reasoning details.                                                                                            |
| Moonshot Kimi             | The API is OpenAI-compatible but adds `thinking`/assistant `partial` extensions and model-specific tool behavior.                                     | Uses portable Chat fields, capability discovery, ordered replay, and local validation.                                                                                       |
| Mistral                   | Tool choice and parallel calls are explicit; JSON mode and JSON Schema support vary by model.                                                         | Maps both controls and chooses the strongest advertised structured mode.                                                                                                     |
| Alibaba Qwen              | Qwen recommends Hermes-style function templates; raw serving behavior depends on the applied chat template.                                           | Does not inject Hermes/control tokens through OpenRouter; uses tool-turn replay and live capabilities.                                                                       |
| Meta Llama                | Tool syntax is tied to the model prompt format and differs across generations.                                                                        | Leaves prompt formatting to the endpoint and conservatively avoids forced choice without live proof.                                                                         |
| xAI Grok                  | Tool arguments are strict by default; structured output with tools is model-family dependent.                                                         | Sends strict-compatible schemas but keeps the portable separation between direct schema and client tools.                                                                    |
| Z.AI GLM                  | Official function calling documents `tool_choice` as `auto` only for the covered API.                                                                 | Rejects forced choices and uses live capabilities for tools/structured output.                                                                                               |
| Cohere Command            | JSON output and strict tools use separate API controls and schema subsets.                                                                            | Uses OpenRouter-advertised structured mode plus local validation; tool strictness stays conservative.                                                                        |
| MiniMax                   | Documented `tool_choice` supports only `auto`/`none`; structured output is model-specific.                                                            | Rejects forced choices and selects structured output per live model metadata.                                                                                                |
| Unknown OpenRouter prefix | No curated behavioral evidence.                                                                                                                       | Plain chat works; tools require live `tools` support, forced choice requires live support, replay is limited to tool turns, and structured output falls back conservatively. |

## The claude kind

`createClaudeProvider` sends Anthropic Messages requests through a Claude Code
subscription login, over the same `LlmProvider` types. The transport contract
is the Messages API at `${baseUrl}/v1/messages?beta=true` with the OAuth beta
headers (`anthropic-version: 2023-06-01`,
`anthropic-beta: oauth-2025-04-20,claude-code-20250219`, `x-app: cli`) and the
Claude Code CLI user agent. The stored value picks its own auth header: a value
that names its `Bearer` scheme is sent as it is, a Console API key
(`sk-ant-api…`) goes as `x-api-key`, and any other token (a `claude
setup-token` value) is sent under `Bearer`. Every request's `system` opens with
Claude Code's own identity block, "You are Claude Code, Anthropic's official
CLI for Claude.", because a subscription login is accepted only when that block
comes first; the caller's system text follows as a second block.

Message and tool mapping follows Anthropic's Messages shapes, per the
[tool-use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
and [structured-outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
documentation and the [Messages API](https://platform.claude.com/docs/en/api/messages)
reference:

- System messages join into the second `system` block, which carries a
  `cache_control: ephemeral` marker (tools and system are cached together), and
  the request carries the top-level automatic `cache_control` for the growing
  conversation.
- A user message is a content-block list whose images travel as `source`
  blocks (`base64` for `data:` URLs, `url` otherwise). A run of tool messages
  collapses into one user message of `tool_result` blocks whose content keeps a
  result's images beside its text; an incomplete result carries
  `is_error: true`.
- An assistant turn Claude answered goes back as its own content blocks
  (thinking with its signature, text, `tool_use`), byte-for-byte, when they
  still name the same tool calls; otherwise it is its thinking blocks, a text
  block and its `tool_use` blocks. Replay items are tagged
  `{ provider: 'claude', block }`, and the OpenAI and OpenRouter bodies skip
  tagged items, as Claude skips untagged ones.
- No empty text block is sent, a turn left with no content is dropped,
  consecutive turns of one role become one, and a history that ends on an
  assistant answer (no `tool_use`) gets a continuation user turn, because a
  final assistant message is a prefill every current model refuses.
- Tool definitions map to `{ name, description, input_schema }`. Tool choice is
  always Anthropic's object form: `{ type: 'auto' | 'none' | 'any' }`
  (`required` is `any`) or `{ type: 'tool', name }`, and
  `parallelToolCalls: false` adds `disable_parallel_tool_use: true`. Opus 5.5,
  Sonnet 5.5, Fable 5.1 and Mythos 5.1 (and their successors) refuse forced
  tool use, so `required` and a named tool become `auto` there.

`temperature` is never sent: Opus 4.7 and later refuse any non-default value.
The request effort becomes `output_config.effort` at a level the model takes:
`none` and `minimal` are `low`; Opus 4.7+, every 5.x model, Fable and Mythos
take `low`–`max` with `xhigh`; Opus 4.6 and Sonnet 4.6 take `low`, `medium`,
`high` and `max` (an `xhigh` request is `high`); Opus 4.5 takes `low`–`high`;
Haiku 4.5, Sonnet 4.5 and older take none, so the field is left out. Models
that think by default (the 5.x families, Fable, Mythos) get
`thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior:
'drop_block' } }` with the `thinking-binding-controls-2026-08-01` beta, so a
history that compaction rewrote drops the thinking blocks it invalidated rather
than being refused; no other model gets a `thinking` field. `max_tokens`
defaults to 64000 for a stream and 16000 for a plain request. Structured output
has no native mode on this transport: a schema request is parsed and validated
locally, and the flag can put the JSON Schema into the system prompt.

`stop_reason` maps back as:

| Anthropic `stop_reason`         | `finishReason`   |
| ------------------------------- | ---------------- |
| `end_turn`                      | `stop`           |
| `stop_sequence`                 | `stop`           |
| `pause_turn`                    | `stop`           |
| `max_tokens`                    | `length`         |
| `model_context_window_exceeded` | `length`         |
| `tool_use`                      | `tool_calls`     |
| `refusal`                       | `content_filter` |
| anything else                   | `unknown`        |

A tool call is a call only when its block closed on JSON a tool can take, so a
`max_tokens` stop never makes a call of the block it cut off. A refusal keeps
no text, calls or replay, and `refusal` names its `stop_details` category and
explanation. A stream that ends without `message_stop` is a retryable
`incomplete_stream` error, never a finished answer; a mid-stream `error` event
keeps Anthropic's type (as the code) and message, and `overloaded_error`,
`api_error` and `rate_limit_error` are retryable. A refused request's error
message carries Anthropic's own (`prompt is too long: …`), with
`retryAfterMs` from `retry-after` and `requestId` from `request-id`; a spend
cap (`enforced_spend_limit_reached`) is never retryable.

Usage reports `inputTokens` as the whole prompt (`input_tokens`, which
Anthropic counts without the cache, plus `cache_creation_input_tokens` and
`cache_read_input_tokens`), with `cacheWriteTokens` and `cachedInputTokens` as
its parts, `output_tokens` as `outputTokens`,
`output_tokens_details.thinking_tokens` as `reasoningTokens`, and
`totalTokens` as input plus output. Each stream `usage` event carries the
counts merged so far.

`models()` lists every page of Anthropic's catalog (`limit=1000`, then
`after_id` while `has_more`), with each model's `max_input_tokens` as its
`contextWindow`; a stream's `response.started` carries the window its model
lists, read once per provider and never failing a request when the lookup
fails. `validateModel` accepts an id with or without its date. The kind keeps
`models` and `reasonings` lists and sets `modelsFromCatalog`, so a provider's
models are the catalog: `claudeCatalogModel` gives each listed model the
efforts its `capabilities.effort` marks supported (`low`, `medium`, `high`,
`xhigh`, `max`, in that order), or the ones its id names when the listing
carries no capabilities, and a default effort of `medium` on Opus 5.5 and
Haiku 5.5 and their successors, `high` elsewhere, none for a model that takes
no effort.
`embedding` and `rerank` are rejected: Claude serves neither through this
transport.

## Primary sources

- OpenRouter: [model `supported_parameters`](https://openrouter.ai/docs/guides/overview/models), [tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), [parameter-required routing](https://openrouter.ai/docs/guides/routing/provider-selection), and [reasoning details](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
- OpenAI: [function calling](https://developers.openai.com/api/docs/guides/function-calling), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), and [model/reasoning guidance](https://developers.openai.com/api/docs/guides/latest-model).
- Anthropic: [tool definitions and strict use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [extended thinking compatibility](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models), and [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
- Google: [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures), [structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output), and [Gemma prompt formatting](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4).
- [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/) and [Chat Completion fields](https://api-docs.deepseek.com/api/create-chat-completion).
- [Kimi API overview](https://platform.kimi.ai/docs/api/overview).
- [Mistral function calling](https://docs.mistral.ai/studio-api/conversations/function-calling) and [structured outputs](https://docs.mistral.ai/studio-api/conversations/structured-output).
- [Qwen function calling](https://qwen.readthedocs.io/en/stable/framework/function_call.html).
- Meta [Llama prompt format](https://github.com/meta-llama/llama-models/blob/main/models/llama3_3/prompt_format.md).
- xAI [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs).
- Z.AI [function calling](https://docs.z.ai/guides/capabilities/function-calling).
- Cohere [structured outputs](https://docs.cohere.com/v2/docs/structured-outputs).
- MiniMax [text API](https://platform.minimax.io/docs/api-reference/text-post).

## Live conformance

The opt-in matrix runs one strict structured case and one two-turn tool/replay
case across 13 representative model families. It fails closed if a model or
price is missing, estimates a five-call-per-model worst case, refuses estimates
above USD 5, and treats every model failure as gating. Each call permits up to
1,024 output tokens so reasoning models can finish the small visible answer.
Pino progress and safe provider diagnostics are written to stderr while stdout
remains reserved for the final JSON report. Set `LLMS_CONFORMANCE_LOG_LEVEL` to
change the default `debug` verbosity.

```sh
npx nx run llms:conformance-live -- --yes-paid-conformance
```

Set `OPENROUTER_API_KEY` only in the runtime environment. The live matrix is
paid and is not part of the ordinary test target.
