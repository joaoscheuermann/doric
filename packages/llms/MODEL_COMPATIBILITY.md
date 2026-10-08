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
| Anthropic Claude          | Forced `any`/named tools are incompatible with manual extended thinking; strict tool use and JSON output have distinct controls.                      | Rejects forced choice plus requested reasoning before completion; preserves replay.                                                                                          |
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
