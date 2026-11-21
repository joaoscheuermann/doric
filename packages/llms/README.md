# llms

One TypeScript contract, `LlmProvider`, for chat completion, streaming, tool
calls, structured output, embeddings, reranking and model listing across model
providers, with one factory per provider: OpenAI Responses-compatible
endpoints, OpenRouter, Claude (Anthropic Messages through a Claude Code login)
and Codex (ChatGPT's Codex backend). Every factory takes an injected HTTP
transport and a Pino logger, so the host decides how credentials, networking
and logs are handled, and tests pass a fake transport. The package also
describes each provider kind's settings fields, reads model catalogs and holds
the model icon set.

It is a library with no state of its own: it persists nothing, starts no
process and opens no connection except through the transport it is given.

Users:

- **Provider bundles** build their provider from it:
  [openai](../../bundles/providers/openai/README.md),
  [openrouter](../../bundles/providers/openrouter/README.md),
  [claude](../../bundles/providers/claude/README.md) and
  [codex](../../bundles/providers/codex/README.md).
- **Foundation and runtime bundles** use its contract, kinds and icons:
  [core](../../bundles/foundation/core/README.md),
  [host-config](../../bundles/foundation/host-config/README.md),
  [transport](../../bundles/foundation/transport/README.md) and
  [default](../../bundles/runtime/default/README.md).
- **Packages**: [agent](../agent/README.md),
  [messages](../messages/README.md) and [okf](../okf/README.md).
- **Applications**: the [host](../../app/backend/doric-host/README.md).
- **Scripts**: [`scripts/okf.mjs`](../../scripts/okf.mjs) builds an OpenAI
  provider with `createFetchTransport` and `createOpenAiProvider`.

The feature that configures providers from settings is described in
[Models and providers](../../docs/features/models-and-providers.md).

## Entry point

[`package.json`](./package.json) exports one entry, `llms`, from
[`src/index.ts`](./src/index.ts) (built to `dist/index.js` with its types in
`dist/index.d.ts`; the `@org/source` condition resolves to the TypeScript
source inside the workspace). Runtime dependencies are `pino` (the logger
type), `zod` (schemas), `tool` (JSON and tool types, see
[tool](../tool/README.md)) and `tslib`. Every value and type named in this
README's code blocks and export lists is exported from that entry; a helper
the README calls internal is not.

## Quick start

```ts
import pino from 'pino';
import { createFetchTransport, createOpenAiProvider } from 'llms';

const provider = createOpenAiProvider({
  transport: createFetchTransport(),
  apiKey: () => process.env.OPENAI_API_KEY ?? '',
  logger: pino(),
});

for await (const event of provider.stream({
  model: 'gpt-5-fast',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Draft the next step.' },
  ],
  effort: 'low',
})) {
  if (event.type === 'text.delta') process.stdout.write(event.delta);
}
```

## The provider contract

Defined in [`src/lib/types/provider.ts`](./src/lib/types/provider.ts).

```ts
type ProviderId = string;
interface ProviderMetadata {
  id: ProviderId;
  name: string;
  baseUrl: string;
}
interface ProviderCapabilities {
  streaming: boolean;
  embeddings: boolean;
  reranking: boolean;
  tools: boolean;
  reasoning: boolean;
  modelListing: boolean;
  oauth: boolean;
  serviceTier: boolean;
  structuredOutputs: boolean;
}

interface LlmProvider {
  readonly metadata: ProviderMetadata;
  readonly capabilities: ProviderCapabilities;
  complete(request): Promise<ProviderFinished<Output>>; // see Structured output
  stream(request): AsyncIterable<ProviderStreamEvent<Output>>;
  embedding(
    request: ProviderEmbeddingRequest,
  ): Promise<ProviderEmbeddingFinished>;
  rerank(request: ProviderRerankRequest): Promise<ProviderRerankFinished>;
  models(signal?: AbortSignal): Promise<readonly Model[]>;
  validateModel(model: string, signal?: AbortSignal): Promise<Model>;
}
```

`complete` and `stream` are overloaded: with a `schema`, `complete` resolves to
`ProviderStructuredFinished<z.output<Schema>>`, whose `structured` field is
always present; without one it resolves to `ProviderFinished<Output>`
(`Output` defaults to `JsonValue`).

```ts
type StructuredOutputSchema = z.ZodType;
type StructuredOutputValue<Schema extends StructuredOutputSchema> =
  z.output<Schema>;
type ProviderStructuredFinished<Output> = Omit<
  ProviderFinished<Output>,
  'structured'
> & { structured: Output };
// Re-exported from `tool`:
type JsonPrimitive = string | number | boolean | null;
type JsonArray = readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
```

### Requests

```ts
interface ProviderRequest<
  Output = JsonValue,
  Schema extends z.ZodType = z.ZodType,
> {
  model: string; // must not be blank
  messages: readonly ProviderMessage[]; // at least one
  tools?: readonly ToolDefinition[]; // from `tool`: name, description, inputSchema, strict
  toolChoice?: ProviderToolChoice;
  parallelToolCalls?: boolean;
  schema?: Schema; // a Zod schema; see Structured output
  effort?: ReasoningEffort;
  temperature?: number;
  maxOutputTokens?: number;
  flags?: ProviderCallFlags;
  signal?: AbortSignal;
}

interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | readonly ProviderContentPart[];
  name?: string;
  toolCallId?: string; // on a tool message
  toolResultStatus?: ProviderToolResultStatus;
  toolCalls?: readonly ProviderToolCall[];
  replay?: readonly ProviderReplayItem[]; // see Replay
}

type ProviderToolChoice = 'auto' | 'required' | 'none' | { name: string };
type ProviderToolResultStatus = 'completed' | 'incomplete';
type ProviderToolCall = ToolCallRequest; // from `tool`: { id, name, arguments: string, index? }
type ProviderReplayItem = JsonObject; // opaque, kept only for replay

type ProviderContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }; // a data: URL or an https: URL
type ProviderImagePart = Extract<ProviderContentPart, { type: 'image' }>;

interface ReasoningRequest {
  effort?: ReasoningEffort;
  summary?: 'auto' | 'concise' | 'detailed';
}

interface ProviderCallFlags {
  reasoning?: boolean | ReasoningRequest;
  serviceTier?: 'auto' | 'default' | 'priority';
  includeUsage?: boolean;
  includeStructuredSchemaOnSystemPrompt?: boolean;
}
```

`reasoningEfforts` is the ordered list `none`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`; `ReasoningEffort` is its member type and
`isReasoningEffort(value)` tests membership. A request's effort is its
top-level `effort`, else `flags.reasoning.effort`
([`common.ts`](./src/lib/providers/common.ts)); each adapter then maps it to
its wire field.

Every adapter checks its input before any request is sent
([`common.ts`](./src/lib/providers/common.ts)) and fails with a
`ProviderErrorObject`: a blank `model` is `missing_model` ("Provider request
requires a model."); an empty `messages` list is `missing_input`.

### Results

```ts
type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error'
  | 'cancelled'
  | 'unknown';

interface ReasoningMetadata {
  text?: string;
  effort?: ReasoningEffort;
  summary?: string;
}

interface ProviderFinished<Output = JsonValue> {
  text: string;
  finishReason: FinishReason;
  usage?: UsageMetadata;
  reasoning?: ReasoningMetadata;
  refusal?: string;
  toolCalls: readonly ProviderToolCall[];
  replay?: readonly ProviderReplayItem[];
  structured?: Output;
}

interface UsageMetadata {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  searchUnits?: number;
  cost?: { amount: number; unit?: string; upstreamAmount?: number };
}
```

OpenAI-shaped usage is read by one parser
([`common.ts`](./src/lib/providers/common.ts)): `input_tokens` or
`prompt_tokens`; `output_tokens` or `completion_tokens`; `total_tokens`;
`reasoning_tokens` at the top or in `completion_tokens_details` /
`output_tokens_details`; `cached_tokens` from `input_tokens_details` or
`prompt_tokens_details`; `cache_write_tokens` from `prompt_tokens_details`;
`search_units`; `cost` as `cost.amount`, `cost_details.upstream_inference_cost`
as `cost.upstreamAmount`. Only finite numbers are kept. OpenRouter sets
`cost.unit` to `credits`; OpenAI sets no unit. Claude reads its own usage
shape (see [Claude](#claude)).

### Stream events

```ts
type ProviderStreamEvent<Output> =
  | {
      type: 'response.started';
      provider: string;
      model: string;
      contextWindow?: number;
    }
  | { type: 'text.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  | { type: 'refusal.delta'; delta: string }
  | {
      type: 'tool_call.delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'tool_call.done'; call: ProviderToolCall }
  | { type: 'usage'; usage: UsageMetadata }
  | { type: 'response.finished'; finish: ProviderFinished<Output> }
  | { type: 'error'; error: ProviderError };
```

Unless it throws, a stream opens with `response.started` and ends with either
one `response.finished` or one `error` event. A delta whose text is
empty is never emitted ([`common.ts`](./src/lib/providers/common.ts)). An
unreadable event (not a JSON object) ends the stream with an `error` event of
code `malformed_stream_event` whose message is the event's raw text, not
bounded by `diagnosticExcerpt`
([`openai.ts`](./src/lib/providers/openai.ts),
[`openrouter/core.ts`](./src/lib/providers/openrouter/core.ts),
[`claude.ts`](./src/lib/providers/claude.ts)). Every other
failure — invalid input or credentials, a refused request, a dropped
connection, the caller's abort — is thrown from the iterator, not emitted,
either before `response.started` or after some events (see
[Errors](#errors)).

### Embeddings and reranking

```ts
interface ProviderEmbeddingRequest {
  model: string;
  input: string;
  dimensions?: number;
  signal?: AbortSignal;
}
interface ProviderEmbeddingFinished {
  embedding: readonly number[];
  usage?: UsageMetadata;
}
interface ProviderRerankRequest {
  model: string;
  query: string;
  documents: readonly string[];
  topN?: number;
  signal?: AbortSignal;
}
interface ProviderRerankResult {
  index: number;
  relevanceScore: number;
}
interface ProviderRerankFinished {
  results: readonly ProviderRerankResult[];
  usage?: UsageMetadata;
}
```

The OpenAI and OpenRouter providers serve both
([`openai.ts`](./src/lib/providers/openai.ts),
[`openrouter/core.ts`](./src/lib/providers/openrouter/core.ts)); Claude and
Codex reject both with `unsupported_embeddings` or `unsupported_reranking`.

- **Embedding** sends `POST {baseUrl}/embeddings` with
  `{ model, input, dimensions? }`; `dimensions` is forwarded unchanged. A blank
  model is `missing_model`, a blank input `missing_input`, and a `dimensions`
  that is not a positive integer `invalid_dimensions`. The result is the
  `embedding` of `data[0]`, which must be a non-empty array of finite numbers,
  else `invalid_embedding`.
- **Reranking** sends `POST {baseUrl}/rerank` with
  `{ model, query, documents, top_n? }` (for OpenRouter,
  `https://openrouter.ai/api/v1/rerank`). A blank query, an empty document list
  or a blank document is `missing_input`; a `topN` that is not a positive
  integer is `invalid_top_n`. Each of `results` must carry a non-negative
  integer `index` (into the original `documents`) and a finite
  `relevance_score`, and there must be at least one, else `invalid_rerank`.
- Both keep the response's `usage` when present (parsed as above), and omit
  `usage` when the response has none
  ([`common.ts`](./src/lib/providers/common.ts)).

### Models

```ts
interface Model {
  id: string;
  name?: string;
  contextWindow?: number;
  inputModalities?: readonly string[]; // absent means unknown, not text alone
  provider?: string;
  raw?: unknown; // the catalog entry as received
}
```

`validateModel(model)` resolves to the listed model with that id and rejects
with `missing_model` ("<name> model is not available: <model>") when the list
lacks it ([`openai.ts`](./src/lib/providers/openai.ts),
[`openrouter.ts`](./src/lib/providers/openrouter.ts),
[`claude.ts`](./src/lib/providers/claude.ts); Codex uses the OpenAI one).
Claude also matches an id with or without its date suffix.

### Capabilities

Each factory fixes its capabilities
([`openai.ts`](./src/lib/providers/openai.ts),
[`openrouter/core.ts`](./src/lib/providers/openrouter/core.ts),
[`claude.ts`](./src/lib/providers/claude.ts),
[`codex.ts`](./src/lib/providers/codex.ts)):

| Provider     | streaming | embeddings | reranking | tools | reasoning | modelListing | oauth | serviceTier | structuredOutputs |
| ------------ | --------- | ---------- | --------- | ----- | --------- | ------------ | ----- | ----------- | ----------------- |
| `openai`     | yes       | yes        | yes       | yes   | yes       | yes          | no    | yes         | yes               |
| `openrouter` | yes       | yes        | yes       | yes   | yes       | yes          | no    | no          | yes               |
| `claude`     | yes       | no         | no        | yes   | yes       | yes          | yes   | no          | no                |
| `codex`      | yes       | no         | no        | yes   | yes       | yes          | yes   | yes         | yes               |

They are exported as `openAiCapabilities`, `openRouterCapabilities`,
`claudeCapabilities` and `codexCapabilities`, beside `openAiMetadata`,
`openRouterMetadata`, `claudeMetadata` and `codexMetadata`.

## Structured output

Implemented in [`structured.ts`](./src/lib/providers/structured.ts).

- **Schema conversion.** `structuredJsonSchema(provider, schema)` converts a Zod
  schema to JSON Schema (`z.toJSONSchema` with `io: 'output'` and
  `unrepresentable: 'throw'`) and returns `undefined` for no schema. It fails
  with `invalid_structured_schema` when the value is not a Zod schema, cannot
  be represented, or does not produce an `object` schema. Every adapter calls it
  before sending, so such a request fails before any network call.
- **`complete` with a schema resolves only on validated JSON**, on every
  provider. A refusal or a tool call, text that is not JSON, and JSON that fails
  `schema.safeParse` all reject with `invalid_structured_output`; on success the
  finish carries the parsed value as `structured`. The diagnostic of a schema
  failure lists each issue as `path: message`, its path segments joined by `.`
  (an issue with no path shows its message alone), the issues joined by `; `.
  The diagnostic of unparseable text is its excerpt, or, when the text is empty
  or whitespace only, `response text was empty; finishReason=<reason>` followed
  by `; outputTokens=<n>` and `; reasoningTokens=<n>` when usage reports them.
  Refusals and tool calls carry no diagnostic.
- **`stream` with a schema** on OpenAI, Codex and Claude streams as usual and
  does not validate: its `response.finished` carries no `structured` value.
  OpenRouter buffers and validates instead (see [OpenRouter](#openrouter)).
- **Strict schemas.** An internal rule (`isStrictCompatible`, not exported)
  treats a JSON Schema as strict when
  every object with `properties` has `additionalProperties: false` and lists
  every property in `required`, recursively. OpenAI and OpenRouter send the
  unmodified schema and mark it `strict` only when it already passes; a tool's
  `inputSchema` is marked strict only when the tool asks for `strict` and the
  schema passes.
- **Schema on the system prompt.** With
  `flags.includeStructuredSchemaOnSystemPrompt: true` and a `schema`, the
  messages become: the authored system messages in their order, then one
  generated system message, then every non-system message in its order. The
  generated message reads "Return exactly one JSON object that matches the JSON
  Schema below. Output just the JSON object string, DO NOT include any Markdown
  fences or any text outside the JSON object." followed by the schema as
  indented JSON in a `json` code fence. The fence is backticks or tildes,
  whichever runs shorter in the schema, at least three and one longer than the
  longest run, so the schema cannot close it. Without the flag, with `false`,
  or without a schema, messages are unchanged. The flag adds to the native
  structured-output field; it does not replace it.

## Replay

An assistant turn's opaque provider output travels in
`ProviderMessage.replay`, so a later request can send it back exactly
(encrypted reasoning, signed thinking, reasoning details). Each provider fills
`ProviderFinished.replay` with its own items: OpenAI and Codex with every item
of the Responses `output`, OpenRouter with the message's `reasoning_details`,
Claude with its own content blocks tagged `{ provider: 'claude', block }`.
When a request is built, OpenAI and OpenRouter send only the untagged items and
Claude only its tagged ones, so a history that switched providers replays only
what the current provider produced
([`common.ts`](./src/lib/providers/common.ts)). Replay never enters the
operational logs.

## Transport

Defined in [`src/lib/types/http.ts`](./src/lib/types/http.ts) and
[`src/lib/http.ts`](./src/lib/http.ts).

```ts
type HttpMethod = 'GET' | 'POST';
type HttpHeaders = Readonly<Record<string, string>>;
interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: HttpHeaders;
  body?: string;
  signal?: AbortSignal;
}
interface HttpResponse {
  status: number;
  headers: HttpHeaders;
  body: string;
}
type HttpStreamChunk = string | Uint8Array;
interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
  stream(request: HttpRequest): AsyncIterable<HttpStreamChunk>;
}
```

- `createFetchTransport(fetcher = fetch)` is the production transport. `request`
  returns status, headers and the body as text whatever the status. `stream`
  yields the response body's chunks; a status that is not OK throws
  `HttpStreamError(status, body, headers)` before any chunk, and a response
  with no body yields nothing.
- `HttpStreamError` has `status`, `diagnostic` (the body, bounded by
  `diagnosticExcerpt`), `headers`, and the message
  "HTTP <status> while opening provider stream."
  ([`http-error.ts`](./src/lib/classes/http-error.ts)).
- `requestJson(transport, provider, request)` sends a request, turns a status of
  400 or more into the HTTP error below, and parses the body as a JSON object,
  failing with `invalid_json` otherwise
  ([`providers/http.ts`](./src/lib/providers/http.ts)).
- `parseSseEvents(chunks: AsyncIterable<HttpStreamChunk>):
AsyncGenerator<SseEvent>` parses server-sent events across arbitrary chunk
  boundaries (`\n` or `\r\n` lines, bytes decoded as UTF-8) into
  `interface SseEvent { event?: string; data: string; done: boolean }`: `data`
  lines are joined by newlines, lines starting with `:` are skipped, a blank
  line or the end of input emits an event only when an `event` or `data` field
  was read since the last one, and `done` is true when the trimmed data is
  `[DONE]` ([`sse.ts`](./src/lib/utils/sse.ts)).

A test transport implements the two methods. For example, with OpenRouter:

```ts
const transport: HttpTransport = {
  async request() {
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    };
  },
  async *stream() {
    yield 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
    yield 'data: [DONE]\n\n';
  },
};
const provider = createOpenRouterProvider({
  transport,
  apiKey: 'test-key',
  logger: pino({ enabled: false }),
});
```

## Credentials

`SecretSource` is `string | (() => string | Promise<string>)`; a function is
read on every call, so a rotated credential reaches a provider built before the
rotation ([`auth.ts`](./src/lib/providers/auth.ts)). The package never reads a
credential store; the host resolves the value. Signing in is the
[oauth](../oauth/README.md) package's.

- **OpenAI** takes `apiKey` (sent as `authorization: Bearer <apiKey>`) or
  `authorization` (sent exactly as given). A blank value counts as absent;
  neither leaves the header off, which some compatible endpoints accept; both
  fail with `auth_ambiguous` ([`auth.ts`](./src/lib/providers/auth.ts)).
- **OpenRouter** requires `apiKey`; a blank one fails with `auth_missing`
  ("OpenRouter provider requires an API key.")
  ([`openrouter/auth.ts`](./src/lib/providers/openrouter/auth.ts)).
- **Claude** requires `authorization`; a blank one fails with `auth_missing`
  (see [Claude](#claude)).
- **Codex** takes `authorization` through the OpenAI rules above: it is sent
  exactly as given, and a blank value counts as absent, so the request goes
  out with no `authorization` header rather than failing
  ([`codex.ts`](./src/lib/providers/codex.ts),
  [`auth.ts`](./src/lib/providers/auth.ts)).

## Errors

Every failure an adapter raises is a `ProviderErrorObject`, an `Error` named
`ProviderError` whose `message` is the data's message and whose `data` is a
`ProviderError` ([`provider-error.ts`](./src/lib/classes/provider-error.ts)).
Other failures keep their own type: aborts and transport errors that pass
through (below), the `TypeError`s a factory throws at construction (logger,
`maxStructuredOutputRepairs`), and the `Error`s of
[provider kinds](#provider-kinds).

```ts
class ProviderErrorObject extends Error {
  constructor(data: ProviderError, options?: ErrorOptions); // options.cause
  readonly data: ProviderError;
}
```

```ts
interface ProviderError {
  provider: string; // the provider's id, including a configured identity
  code: string;
  message: string;
  status?: number; // the HTTP status, when there was one
  retryable?: boolean;
  diagnostic?: string; // a bounded excerpt of what the provider returned
  retryAfterMs?: number; // Claude: the wait `retry-after` asks for
  requestId?: string; // Claude: Anthropic's request id
}
```

| Code                                                                                                         | When                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http_error`                                                                                                 | The provider answered with status 400 or more (other than 401/403). Message "<provider> request failed with HTTP <status>."; retryable for 429 and 5xx. |
| `auth_failed`                                                                                                | Status 401 or 403.                                                                                                                                      |
| `auth_missing`, `auth_ambiguous`                                                                             | A required credential is blank; both an API key and an authorization were given.                                                                        |
| `network_error`                                                                                              | The connection could not be made or dropped (below).                                                                                                    |
| `missing_model`, `missing_input`, `invalid_dimensions`, `invalid_top_n`                                      | An invalid request; also `missing_model` for a model the catalog does not list.                                                                         |
| `invalid_json`, `invalid_embedding`, `invalid_rerank`, `missing_stream_finish`                               | An unreadable provider response.                                                                                                                        |
| `malformed_stream_event`, `provider_error`, `incomplete_stream`                                              | Stream error events (see each provider).                                                                                                                |
| `invalid_structured_schema`, `invalid_structured_output`, `unsupported_structured_tools`                     | Structured output.                                                                                                                                      |
| `unsupported_embeddings`, `unsupported_reranking`, `unsupported_model_feature`, `incompatible_model_request` | A feature the provider or model lacks.                                                                                                                  |

Claude also passes Anthropic's error types through as codes on stream errors
(see [Claude](#claude)).

Each factory wraps its transport so that a transport failure carries the
provider's identity ([`providers/http.ts`](./src/lib/providers/http.ts)):

- An abort (the request's signal is aborted, or the error is an `AbortError`)
  and an error that is already a `ProviderErrorObject` pass through unchanged,
  so cancellation keeps its identity.
- An `HttpStreamError` becomes the HTTP error of its status (`auth_failed` or
  `http_error`) with the stream's diagnostic, and keeps the original as its
  `cause`.
- A failure whose own `code`, or the `code` of a `cause` followed up to eight
  levels, is `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`, `ECONNRESET`,
  `UND_ERR_SOCKET` or `EAI_AGAIN` becomes a retryable `network_error`, message
  "Could not connect to <provider>.", with the original error as its `cause`.
  This covers a connection dropped mid-stream as well as one never made. The
  cause carries the transport's details, such as addresses and ports.
- Anything else, an unresolvable host (`ENOTFOUND`) included, passes through
  unchanged.

`diagnosticExcerpt(value, limit = 2048)` returns the value when it fits and
otherwise its first `limit` characters followed by `...[truncated]`
([`diagnostics.ts`](./src/lib/utils/diagnostics.ts)). The bound limits volume;
it does not hide content.

## Logging and content privacy

Every factory requires a Pino logger and throws `TypeError` ("LLM provider
requires a Pino-compatible logger.") at construction when the value lacks a
`debug` or a `child` function. It logs through a child bound to
`{ component: 'llms', provider: <provider id> }`, every event at `debug`
([`logging.ts`](./src/lib/providers/logging.ts)):

- `llm provider initialized` once;
- `llm <operation> started` and then one of `completed`, `failed` or
  `cancelled`, where the operation is `completion`, `stream`, `embedding`,
  `rerank`, `model listing` or `model validation`. A failure is `cancelled`
  when the request's signal is aborted or the error is an `AbortError`. A
  stream ends at its first `error` event (`failed`) or `response.finished`
  (`cancelled` or `failed` when the finish reason says so, `completed`
  otherwise); a stream that ends with neither event logs `completed`; a
  stream the consumer stops reading is `cancelled`.
- Fields are counts and identifiers only: `model`, `messageCount`,
  `toolCount`, `hasSchema` when a completion or stream starts; `finishReason`,
  `toolCount` and the usage counts (`inputTokens` … `searchUnits`, `cost`,
  `costUnit`, `upstreamCost`) when it completes from a finish; `model` when an
  embedding starts and `dimensions` plus usage counts when it completes;
  `model` and `documentCount` when a rerank starts and `resultCount` plus usage
  counts when it completes; `modelCount` when a listing completes; `model` when
  a validation starts and completes. `failed` and `cancelled` lines, and a
  stream's `completed` without a finish, carry no fields. No message, response
  text, replay item or credential is logged.

The package does not classify, redact or sanitize content, and has no
per-request flag for it. Error diagnostics keep provider content unredacted,
bounded in size, except the message of `malformed_stream_event`, which is the
raw event text, unbounded; parse errors may keep their original `cause`. Displaying,
storing and logging an error is the caller's decision, and the injected logger
(which a caller may disable) controls log output.

## Providers

### OpenAI Responses-compatible endpoints

`createOpenAiProvider(deps: OpenAiProviderDeps): LlmProvider`
([`openai.ts`](./src/lib/providers/openai.ts)) talks to any endpoint that
answers the OpenAI Responses API.

```ts
interface OpenAiProviderDeps {
  transport: HttpTransport;
  logger: Logger;
  apiKey?: SecretSource;
  authorization?: SecretSource;
  baseUrl?: string; // default https://api.openai.com/v1
  identity?: { id: string; name: string }; // default { id: 'openai', name: 'OpenAI' }
}
```

- **Identity.** `metadata` is the identity with the effective `baseUrl`. The
  identity's id is the `provider` of every stream event, model, log line and
  error, and its name appears in messages, for every operation (`/responses`,
  `/models`, `/embeddings`, `/rerank`).
- **Endpoints.** `complete` and `stream` send `POST {baseUrl}/responses`
  (a Chat Completions-only endpoint is not supported); `models()` sends
  `GET {baseUrl}/models` and maps each entry of `data` with an id to
  `{ id, name: id, provider, raw }`.
- **Body** (`openAiBody(request, stream, provider?)`,
  [`openai/body.ts`](./src/lib/providers/openai/body.ts)):
  - `instructions`: the system messages' text joined by a blank line;
  - `input`: a user message is `{ role, content }` of `input_text` and
    `input_image` parts; a tool message is a `function_call_output` with
    `call_id`, `status` (`toolResultStatus`) and `output` — the plain text, or
    the parts when the result carries images; an assistant message is its
    untagged replay items when it has some, otherwise one `function_call` item
    per tool call (its text is not sent);
  - `tools`: `{ type: 'function', name, description, parameters, strict }`;
    `tool_choice` is the string, or `{ type: 'function', name }` for a named
    tool; `parallel_tool_calls` as given;
  - `text.format`: `{ type: 'json_schema', name: 'structured_output', strict, schema }`
    when there is a schema;
  - `temperature`, `max_output_tokens`;
  - `service_tier`: `flags.serviceTier`, else `priority` for a model whose id
    ends in `-fast`, whose suffix is removed from `model`;
  - `reasoning`: `{ effort }` from the request's effort, plus `summary` from
    `flags.reasoning`; `flags.reasoning: true` with no effort sends `{}`;
  - `store: false` always, and `stream`.
- **Complete.** Text is the `output_text` field or the joined `output_text`
  parts; refusal from `refusal` parts; tool calls from `function_call` items;
  reasoning text from the `summary` of `reasoning` items; `replay` is the whole
  `output` ([`openai/parse.ts`](./src/lib/providers/openai/parse.ts)). The
  finish reason is `tool_calls` when there are calls, `content_filter` when
  there is a refusal, `stop` for status `completed`, `error` for `failed`,
  `cancelled`, and `unknown` otherwise.
- **Stream.** `response.started` names the model as sent (without `-fast`).
  `response.output_text.delta` is `text.delta`;
  `response.reasoning_summary_text.delta` and `response.reasoning_text.delta`
  are `reasoning.delta`; `response.refusal.delta` is `refusal.delta`;
  `response.function_call_arguments.delta` is `tool_call.delta` at its
  `output_index`; a `function_call` item's `response.output_item.done` is
  `tool_call.done`. `response.completed` yields `usage` (when present) and
  `response.finished` from the completed response; when no text delta came,
  the text is taken from the `.done` snapshots. `response.failed` ends with an
  `error` event of code `provider_error` ("<name> stream failed."). A stream
  that ends without either yields `response.finished` with finish reason
  `unknown` and what it gathered.

### OpenRouter

`createOpenRouterProvider(deps: OpenRouterProviderDeps): LlmProvider`
([`openrouter.ts`](./src/lib/providers/openrouter.ts)) uses OpenRouter's Chat
Completions API (`POST {baseUrl}/chat/completions`) with per-model policy.

```ts
interface OpenRouterProviderDeps {
  transport: HttpTransport;
  logger: Logger;
  apiKey: SecretSource; // required
  baseUrl?: string; // default https://openrouter.ai/api/v1
  modelsUrl?: string; // default `${baseUrl}/models`
  maxStructuredOutputRepairs?: number; // default 2 (defaultStructuredOutputRepairs)
}
```

`maxStructuredOutputRepairs` must be a non-negative safe integer; any other
value throws `TypeError` at construction. `metadata` is always
`openRouterMetadata` (`id: 'openrouter'`, `baseUrl` the default).

**Catalog.** `models()` reads `GET {modelsUrl}` and maps each entry of `data`
to a `Model` with `id` from `id` (an entry without one is kept with id `''`),
`name` from `name`, `contextWindow` from `context_length` (else
`top_provider.context_length`, else `architecture.context_length`),
`inputModalities` from `architecture.input_modalities`, `provider:
'openrouter'` and the entry as `raw`
([`openrouter/models.ts`](./src/lib/providers/openrouter/models.ts)). The
catalog is shared by the provider instance
([`openrouter/catalog.ts`](./src/lib/providers/openrouter/catalog.ts)): one
load at a time, bounded by a 5-second timeout of its own; a success is kept 15
minutes; a failure is not retried for 30 seconds, during which the last good
catalog is served, or the failure is thrown when there is none. A caller's
abort rejects its own wait without cancelling the shared load. A model's
support is its catalog entry's `supported_parameters`; a model the catalog does
not list has none; when no catalog can be read, support is unknown.
`validateModel` reads the same shared catalog.

Two operations read the catalog. Every `stream` without a schema awaits the
model's catalog entry before it emits `response.started`, to add its
`contextWindow`, so with a cold or expired cache the first event waits for the
catalog load (up to its 5-second timeout); a failed load gives no window and
does not fail the stream. The request policy below reads it only when a
request has tools or a schema.

**Request policy**
([`openrouter/prepare.ts`](./src/lib/providers/openrouter/prepare.ts),
[`openrouter/profiles.ts`](./src/lib/providers/openrouter/profiles.ts)). The
policy checks consult the catalog only when a request has tools or a schema;
otherwise support is unknown. A profile is chosen by the model id's prefix by
an internal rule (`openRouterProfileForModel`, not exported):

| Prefix         | Lab       | Forced tool choice    | Forced choice with reasoning | Replay     | Strict tools |
| -------------- | --------- | --------------------- | ---------------------------- | ---------- | ------------ |
| `google/gemma` | gemma     | `auto`/`none` only    | yes                          | tool turns | no           |
| `google/`      | gemini    | yes                   | yes                          | all        | yes          |
| `openai/`      | openai    | yes                   | yes                          | all        | yes          |
| `anthropic/`   | anthropic | yes                   | no                           | all        | yes          |
| `deepseek/`    | deepseek  | yes                   | yes                          | all        | no           |
| `moonshotai/`  | kimi      | yes                   | yes                          | all        | no           |
| `mistralai/`   | mistral   | yes                   | yes                          | all        | yes          |
| `qwen/`        | qwen      | yes                   | yes                          | tool turns | no           |
| `meta-llama/`  | llama     | `auto`/`none` only    | yes                          | tool turns | no           |
| `x-ai/`        | xai       | yes                   | yes                          | all        | yes          |
| `z-ai/`        | glm       | `auto`/`none` only    | yes                          | all        | no           |
| `cohere/`      | cohere    | yes                   | yes                          | all        | no           |
| `minimax/`     | minimax   | `auto`/`none` only    | yes                          | all        | no           |
| any other      | unknown   | from the catalog only | no                           | tool turns | no           |

Every named lab's profile treats tools as supported; `unknown`'s does not. In
order, a request is then:

1. rejected with `unsupported_structured_tools` when it has both tools and a
   schema ("…Use the agent terminal-tool contract for tool-enabled structured
   runs.");
2. rejected with `unsupported_model_feature` when it has tools and the model
   does not support `tools` (by the catalog, or by the profile when support is
   unknown);
3. for a forced choice (`required` or a named tool): rejected with
   `incompatible_model_request` when reasoning is requested and the profile
   refuses forced choice
   with reasoning (reasoning is requested when the request's effort — its
   `effort`, else `flags.reasoning.effort` — is set and is not `none`; with no
   effort, when `flags.reasoning` is `true` or an object; so
   `flags.reasoning: false` and `flags.reasoning: { effort: 'none' }` are not
   reasoning); rejected with `unsupported_model_feature` when the catalog
   lacks `tool_choice` (or, with unknown support, the profile is not full) or
   when a named lab's profile allows only `auto`/`none`;
4. given a structured mode: `json_schema` when the catalog lists
   `structured_outputs`, else `json_object` when it lists `response_format`,
   else `prompt`;
5. normalized: when the catalog lacks `tool_choice`, `none` drops the tools and
   the choice and `auto` drops the choice; `parallelToolCalls` is dropped unless
   the catalog lists `parallel_tool_calls`; and when `parallelToolCalls` is
   `false` and tools remain, this system message is placed after the authored
   system messages:

   ```text
   # Tool use

   Call at most one available tool in each response.
   This limit applies only to the current response, not to the task or node.
   After receiving the result, call another tool in a later response when more work or recovery is needed.
   ```

**Body** (`openRouterBody(request, stream, options?)`,
[`openrouter/body.ts`](./src/lib/providers/openrouter/body.ts)): `model`;
`messages` as Chat messages (user images as `image_url` parts; a tool result's
images sent after its run of tool messages as one user message, each set
introduced by "The tool call \`<id>\` returned these images:"; assistant
`reasoning_details` from replay, only on turns with tool calls when the profile
replays tool turns); `tools` as `{ type: 'function', function: { name,
description, parameters, strict } }`, `strict` omitted on profiles without
strict tools; `tool_choice` (`{ type: 'function', function: { name } }` for a
named tool); `parallel_tool_calls`; `temperature`; `max_tokens`; `reasoning:
{ effort, summary }` when an effort or `flags.reasoning` is set;
`response_format` (`json_schema` named `structured_output` with `strict`, or
`{ type: 'json_object' }`, or none for `prompt`); `provider:
{ require_parameters: true }` when tools remain or a schema uses a native mode;
`stream`; and `stream_options: { include_usage: true }` unless
`flags.includeUsage` is `false`. In `json_object` and `prompt` modes the schema
is always placed on the system prompt as described in
[Structured output](#structured-output).

**Complete** ([`openrouter/parse.ts`](./src/lib/providers/openrouter/parse.ts)):
text, `reasoning` (or `reasoning_content`), `refusal`, `tool_calls` and
`reasoning_details` (as replay) of the first choice; the finish reason is
`finish_reason` when it is `stop`, `length`, `tool_calls`, `content_filter`,
`cancelled`, `error` (also for `failed`), else `unknown`. With a schema, the
answer is validated; an `invalid_structured_output` failure is retried up to
`maxStructuredOutputRepairs` times, each attempt appending to the previous
attempt's messages the rejected answer (its text, with its replay) as an
assistant message and this user message:

```text
# Structured output correction

The previous response was rejected because it did not match the required JSON object schema.
Return exactly one corrected JSON object. Do not include Markdown or explanatory text.
```

Usage is summed over the attempts (costs only when their units agree). Any
other error, or the last failure, rejects.

**Stream.** Without a schema: `response.started` carries the model's catalog
`contextWindow` when known; each chunk yields `usage`, `text.delta`,
`reasoning.delta`, `refusal.delta` and `tool_call.delta` events; a chunk whose
`error` field is an object ends the stream with an `error` event of code
`provider_error` ("OpenRouter stream error.") whose diagnostic is the chunk;
every choice of every chunk sets the finish reason from its `finish_reason`
(`unknown` when it has none), so the last choice read decides; at `[DONE]` or
the end of input every accumulated call is emitted as `tool_call.done`, then
`response.finished` with that finish reason (`unknown` when no choice came).
With a schema the stream is atomic: it runs `complete` (with its repairs),
then yields `response.started`, one `text.delta` with the whole text when it is
not empty, and `response.finished` with the validated `structured` value; a
failure rejects the iterator.

The research behind each lab's profile, with its primary sources, is in
[MODEL_COMPATIBILITY.md](./MODEL_COMPATIBILITY.md).

### Claude

`createClaudeProvider(deps: ClaudeProviderDeps): LlmProvider`
([`claude.ts`](./src/lib/providers/claude.ts)) sends Anthropic Messages
requests through a Claude Code subscription login.

```ts
interface ClaudeProviderDeps {
  transport: HttpTransport;
  logger: Logger;
  authorization: SecretSource; // a Claude sign-in, a `claude setup-token` value, or a Console API key
  baseUrl?: string; // default https://api.anthropic.com
}
```

- **Requests** go to `POST {baseUrl}/v1/messages?beta=true` with
  `anthropic-version: 2023-06-01`, `anthropic-beta:
oauth-2025-04-20,claude-code-20250219` (plus
  `thinking-binding-controls-2026-08-01` when the body sets `thinking`),
  `x-app: cli` and `user-agent` `claudeUserAgent`
  (`claude-cli/2.1.309 (external, cli)`).
- **Credential.** The value is read (a source is called) and trimmed; blank
  fails with `auth_missing` ("Claude provider received an empty auth value.").
  A value that starts with `bearer` (any case) followed by whitespace is sent
  as `authorization` as it is; one that starts with `sk-ant-api` as
  `x-api-key`; any other as `authorization: Bearer <value>`.

**Body** ([`claude/body.ts`](./src/lib/providers/claude/body.ts)):

- `system` is two text blocks: "You are Claude Code, Anthropic's official CLI
  for Claude.", then the caller's system messages' text joined by a blank line
  (left out when empty). The last block carries
  `cache_control: { type: 'ephemeral' }`, and the body carries the same
  top-level `cache_control`.
- `messages` are built from the non-system messages:
  - a user message is a list of `text` blocks and `image` blocks in order
    (empty text dropped); an image's `source` is
    `{ type: 'base64', media_type, data }` for a `data:` URL that carries
    `;base64,`, and `{ type: 'url', url }` otherwise;
  - a tool message is a user turn holding one
    `{ type: 'tool_result', tool_use_id, content }` block, `content` being the
    text, or text and image blocks when the result carries images, with
    `is_error: true` when `toolResultStatus` is `incomplete`;
  - an assistant message is its tagged Claude replay blocks, sent
    byte-for-byte, when it has some and their `tool_use` blocks name the
    message's tool calls (same count, same ids, same order); otherwise it is the
    replay's `thinking` and `redacted_thinking` blocks, then a `text` block
    (when the text is not empty), then one
    `{ type: 'tool_use', id, name, input }` per tool call, `input` being its
    arguments parsed as a JSON object, or `{}`;
  - a turn with no blocks is dropped and consecutive turns of one role are
    merged into one, so a run of tool results (and a user message after them)
    is one user message;
  - when the last turn is the assistant's and holds no `tool_use` block, a user
    turn "Continue from where your previous response ended." is added.
- `tools` are `{ name, description, input_schema }`. `tool_choice` is sent only
  when there are tools, and then only when `toolChoice` is set or
  `parallelToolCalls` is `false`: `auto` and `none` as `{ type }`, `required`
  as `{ type: 'any' }`, a named tool as `{ type: 'tool', name }`, no choice as
  `{ type: 'auto' }`; on a model that refuses forced tool use, `required` and a
  named tool become `{ type: 'auto' }`; `parallelToolCalls: false` adds
  `disable_parallel_tool_use: true` unless the type is `none`.
- `temperature` is never sent. `max_tokens` is `maxOutputTokens`, else 64000
  for a stream and 16000 otherwise.
- A schema has no native mode: `complete` validates the answer locally, and
  `flags.includeStructuredSchemaOnSystemPrompt` can put the schema on the
  system prompt.

**Models and effort** ([`claude/models.ts`](./src/lib/providers/claude/models.ts)).
A model id is read as `claude-<family>-<major>[-<minor>]`, the family one of
`opus`, `sonnet`, `haiku`, `fable`, `mythos` (lowercased, a missing minor read
as 0, a date or `@` suffix allowed); an id that does not match is treated as a
model that takes no effort, does not think by default and accepts forced tool
choice.

| Model                                                   | Effort levels taken                     | Thinks by default | Refuses forced tool choice                          |
| ------------------------------------------------------- | --------------------------------------- | ----------------- | --------------------------------------------------- |
| Any family at major 5 or later, Fable, Mythos           | `low`, `medium`, `high`, `xhigh`, `max` | yes               | Opus and Sonnet from 5.5; Fable and Mythos from 5.1 |
| Opus 4.7 and later 4.x                                  | `low`, `medium`, `high`, `xhigh`, `max` | no                | no                                                  |
| Opus 4.6                                                | `low`, `medium`, `high`, `max`          | no                | no                                                  |
| Opus 4.5                                                | `low`, `medium`, `high`                 | no                | no                                                  |
| Sonnet 4.6 and later 4.x                                | `low`, `medium`, `high`, `max`          | no                | no                                                  |
| Any other (Haiku 4.x, Sonnet 4.5 and older, older Opus) | none                                    | no                | no                                                  |

- The request's effort becomes `output_config.effort`: `none` and `minimal`
  become `low`; a level the model takes is sent as is; a level it lacks becomes
  `high`, or its strongest level when it lacks `high`; a model that takes none
  gets no `output_config`.
- A model that thinks by default gets
  `thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }`
  (and the binding beta header); no other model gets a `thinking` field.

**Results** ([`claude/parse.ts`](./src/lib/providers/claude/parse.ts)):

- `complete` reads `content`: `text` blocks are the text, `thinking` blocks the
  reasoning text, each `tool_use` block a tool call whose arguments are its
  `input` as JSON (`{}` when absent).
- A stream reads Anthropic's events: `message_start` (usage);
  `content_block_start` opens a block; `text_delta` is `text.delta`,
  `thinking_delta` is `reasoning.delta`, `signature_delta` extends a thinking
  block's signature, `input_json_delta` on a `tool_use` block is
  `tool_call.delta`; `content_block_stop` emits `tool_call.done` for a
  `tool_use` block whose accumulated JSON (`{}` when empty) parses as an object,
  so a block a `max_tokens` stop cut off is never a call; `message_delta`
  carries `stop_reason`, `stop_details` and usage; `message_stop` emits
  `response.finished`.
- `stop_reason` maps to `stop` (`end_turn`, `stop_sequence`, `pause_turn`),
  `length` (`max_tokens`, `model_context_window_exceeded`), `tool_calls`
  (`tool_use`), `content_filter` (`refusal`) or `unknown`.
- A refusal keeps no text, tool calls or replay; `refusal` is "Claude declined
  to answer", then ` (<stop_details.category>)` when present, then
  `: <stop_details.explanation>` or `.`.
- Replay is kept only for a turn that holds a `thinking` block with a
  signature or a `redacted_thinking` block: every block (`thinking` with its
  signature, `redacted_thinking`, non-empty `text`, valid `tool_use`) in order,
  each tagged `{ provider: 'claude', block }`; a thinking block without a
  signature is left out.
- Usage: `inputTokens` is the sum of `input_tokens`,
  `cache_creation_input_tokens` and `cache_read_input_tokens` (those present),
  with `cacheWriteTokens` and `cachedInputTokens` as the last two;
  `outputTokens` is `output_tokens`; `reasoningTokens` is `thinking_tokens` (at
  the top or in `output_tokens_details`); `totalTokens` is input plus output.
  A stream merges each payload's numeric counts into the ones reported before
  and emits a `usage` event with the merged counts each time.

**Errors:**

- A stream payload of type `error`, or one with an `error` object, ends the
  stream with an `error` event whose code is Anthropic's error type (else
  `provider_error`), whose message is "Claude stream error (<type>): <message>"
  (each part left out when absent, ending in `.` without a message), whose
  diagnostic is the payload, and which is retryable for `overloaded_error`,
  `api_error` and `rate_limit_error` unless `error.details.error_code` is
  `enforced_spend_limit_reached`.
- A stream that ends without `message_stop` ends with a retryable
  `incomplete_stream` error ("Claude stream ended before the response
  finished.").
- A refused request or stream (status 400 or more) is `auth_failed` (401, 403)
  or `http_error`, with the message "claude request failed with HTTP
  <status>: <Anthropic's message>" (`.` without one) plus " Sign in with Claude
  again to renew the login." on 401; retryable for 429 and 5xx unless the
  spend cap code is present; `retryAfterMs` from `retry-after` (seconds, or an
  HTTP date, never negative); `requestId` from the `request-id` header, else the
  body's `request_id`; the body as diagnostic.

**Catalog.** `models()` reads every page of
`GET {baseUrl}/v1/models?beta=true&limit=1000`, adding
`&after_id=<last_id, else the last listed id>` while `has_more` is `true`; each
entry with an id becomes a `Model` with `name` from `display_name`,
`contextWindow` from `max_input_tokens`, and `inputModalities`
`['text', 'image']` or `['text']` when `capabilities.image_input.supported` is
a boolean. `validateModel` accepts an id with or without its 8-digit date
suffix. A stream's `response.started` carries the model's `contextWindow`,
read from a catalog the provider lists once and keeps for its lifetime; a
failed listing is kept as an empty catalog, so it gives no window and never
fails a request.

`embedding` and `rerank` reject (`unsupported_embeddings`,
`unsupported_reranking`). The research behind these rules, with its primary
sources, is in [MODEL_COMPATIBILITY.md](./MODEL_COMPATIBILITY.md).

### Codex

`createCodexProvider(deps: CodexProviderDeps): LlmProvider`
([`codex.ts`](./src/lib/providers/codex.ts)) uses ChatGPT's Codex Responses
backend through the OpenAI adapter. It is not listed by `providerKinds`.

```ts
interface CodexProviderDeps {
  transport: HttpTransport;
  logger: Logger;
  authorization: SecretSource; // sent exactly as the authorization header; blank sends none
  chatGptAccountId?: SecretSource; // sent as ChatGPT-Account-ID
  fedramp?: boolean; // true sends X-OpenAI-Fedramp: true
  baseUrl?: string; // default https://chatgpt.com/backend-api/codex
}
```

The body is the OpenAI body without `temperature`, with `store: false`, and
with `instructions` "You are Codex, a coding agent." when the request has no
system text. A blank `authorization` is treated as absent, so the request is
sent with no `authorization` header; a blank `chatGptAccountId` fails with
`auth_missing` ("Codex provider received an empty auth value."). `metadata` is
always `codexMetadata` (`id: 'codex'`, `baseUrl` the default), whatever
`baseUrl` is given. `complete`
runs a stream and resolves with its `response.finished` (validated when there
is a schema), rejects with the stream's `error`, or with
`missing_stream_finish` when the stream ends without either. `models()` reads
`GET {baseUrl}/models`. `embedding` and `rerank` reject.

## Provider kinds

[`kinds.ts`](./src/lib/providers/kinds.ts) describes what a settings surface
shows for each kind and builds a provider from the values it stores.

```ts
type ProviderKindId = 'openai' | 'openrouter' | 'codex' | 'claude';
type ProviderFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';
type ProviderListId = 'models' | 'reasonings';
interface ProviderField {
  key: string;
  label: string;
  kind: ProviderFieldKind;
  required: boolean;
  description?: string;
  placeholder?: string;
  options?: readonly string[]; // enum fields only
  advanced?: boolean;
}
interface ProviderKind {
  id: ProviderKindId;
  label: string;
  description: string;
  fields: readonly ProviderField[];
  lists: readonly ProviderListId[];
  modelsFromCatalog?: boolean;
  site?: { url: string; label: string };
}
type ProviderValues = Readonly<Record<string, SecretSource>>;
interface ProviderKindDeps {
  transport: HttpTransport;
  logger: Logger;
  identity: { id: string; name: string };
}
type ConfiguredProvider = LlmProvider & {
  kind: ProviderKindId;
  configuration: readonly ProviderField[];
};
```

The kinds, in order:

| Kind         | Label      | Description                                                                                                         | Lists                  | Other                                              |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------- |
| `openai`     | OpenAI     | "Any endpoint that answers the OpenAI Responses API, under its own identity."                                       | `models`, `reasonings` |                                                    |
| `openrouter` | OpenRouter | "OpenRouter Chat Completions with curated model profiles, live capability discovery, and structured-output repair." | `models`, `reasonings` | `site`: `https://openrouter.ai`, "Open OpenRouter" |
| `codex`      | Codex      | "The ChatGPT Codex Responses backend, authenticated with a Codex authorization value."                              | none                   |                                                    |
| `claude`     | Claude     | "Anthropic Messages through a Claude Code subscription login, authenticated with a Claude authorization value."     | `models`, `reasonings` | `modelsFromCatalog: true`                          |

Their fields, each listed with its kind:

| Key                          | Label                     | Field kind               | Required                       | Advanced | Placeholder                                                                                                                                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Kinds        |
| ---------------------------- | ------------------------- | ------------------------ | ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `endpoint`                   | Endpoint                  | `url`                    | no                             | yes      | the kind's default base URL (`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, `https://chatgpt.com/backend-api/codex`, `https://api.anthropic.com`) | "Overrides the base URL requests are sent to."                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | all, first   |
| `token`                      | Token                     | `secret`                 | no for `openai`, yes otherwise | no       |                                                                                                                                                                 | `openai`: "Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a compatible endpoint may accept."; `openrouter`: "Names the stored API_TOKEN credential this provider authenticates with."; `codex`: "Names the stored API_TOKEN credential that carries the Codex authorization value."; `claude`: "Names the stored API_TOKEN credential that carries the Claude authorization value: a Claude sign-in, a `claude setup-token` value, or a Console API key." | all, second  |
| `maxStructuredOutputRepairs` | Structured output repairs | `number`                 | no                             | yes      | `2`                                                                                                                                                             | "How many corrected attempts a rejected structured response gets."                                                                                                                                                                                                                                                                                                                                                                                                                                              | `openrouter` |
| `modelsUrl`                  | Models URL                | `url`                    | no                             | yes      | `https://openrouter.ai/api/v1/models`                                                                                                                           | "Where this provider lists the models it serves and what each one accepts."                                                                                                                                                                                                                                                                                                                                                                                                                                     | `openrouter` |
| `chatGptAccountId`           | ChatGPT account ID        | `text`                   | no                             | no       |                                                                                                                                                                 | "The account id sent as ChatGPT-Account-ID beside the authorization value."                                                                                                                                                                                                                                                                                                                                                                                                                                     | `codex`      |
| `fedramp`                    | FedRAMP                   | `enum` (`true`, `false`) | no                             | no       | `false`                                                                                                                                                         | "Sends X-OpenAI-Fedramp for a FedRAMP ChatGPT account."                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `codex`      |

A `token` value names a stored credential; the host resolves it and passes the
value or a source.

- `providerKinds` lists `openai`, `openrouter` and `claude`; `providerKind(id)`
  finds any of the four, or `undefined`.
- `createProviderForKind(id, values, deps)` throws `Error` "Unknown provider
  kind: <id>" for an unknown id and "Provider kind <id> requires a <key> value."
  for a required field that is absent or blank, then calls the kind's factory:
  `token` becomes `apiKey` (OpenAI, OpenRouter) or `authorization` (Codex,
  Claude); `endpoint` becomes `baseUrl`; `identity` is passed to the OpenAI
  factory only. Every non-`token` value must be a string (else "Provider value
  <key> is a literal, not a source."); `maxStructuredOutputRepairs` must parse
  as a finite number (else "Provider value maxStructuredOutputRepairs is not a
  number: <value>"), and then pass the OpenRouter factory's own check;
  `fedramp` must be `true` or `false` (else "Provider value fedramp is not a
  flag: <value>"). An absent value
  leaves the factory's default. The result carries `kind` and its fields as
  `configuration`.

## Model catalogs

[`models.ts`](./src/lib/providers/models.ts) and
[`claude/models.ts`](./src/lib/providers/claude/models.ts):

```ts
interface CatalogModel {
  id: string;
  name?: string;
  reasonings: readonly ReasoningEffort[];
  parameters: readonly string[];
  defaultEffort?: ReasoningEffort;
  mandatory: boolean;
}
```

- `modelCatalog(response)` reads an OpenAI-shaped `/models` answer into a map by
  id: `name`; `reasonings` from `reasoning.supported_efforts` (known efforts
  only); `parameters` from `supported_parameters`; `defaultEffort` from
  `reasoning.default_effort` when it is one of the model's efforts; `mandatory`
  when `reasoning.mandatory` is `true`.
- `claudeCatalogModel(model)` turns a Claude `Model` into its entry:
  `reasonings` are the levels (`low`, `medium`, `high`, `xhigh`, `max`, in that
  order) its `capabilities.effort` marks supported, none when it marks effort
  unsupported, or the levels its id implies when the listing carries no
  capabilities; `defaultEffort` is `medium` on Opus and Haiku 5.5 and later,
  `high` elsewhere, falling back to the strongest listed level; `parameters` is
  empty and `mandatory` is `false`.

## Model icons

[`icons/index.ts`](./src/lib/icons/index.ts) holds eight LobeHub mono SVG icons
(`claude`, `deepseek`, `gemini`, `gemma`, `meta`, `openai`, `openrouter`,
`qwen`), whose source and hashes are in [PROVENANCE.md](./PROVENANCE.md).

- `ModelIconName` is the icon names; `isModelIconName(value)` tests an own key;
  `modelIconSvg(name)` returns the SVG text.
- `modelFamilies: readonly ModelFamily[]`, where
  `interface ModelFamily { icon: ModelIconName; lab: OpenRouterLab; word: string }`
  and `OpenRouterLab` (a type that is not exported) is one of the labs of the
  OpenRouter table, lists, in
  matching order, `{ icon, lab, word }` for claude
  (`anthropic`), gemini, gemma, openai (`gpt`), deepseek, qwen and meta
  (`llama`).
- `openRouterModelIcon(model)` is the icon of the family whose lab the
  OpenRouter profile reads from the id, else `null`.
- `modelNameIcon(model)` is the icon of the first family whose word the
  lowercased name contains, else `null`.

## Live conformance

[`scripts/conformance-live.mjs`](./scripts/conformance-live.mjs) checks the
built OpenRouter provider against real models and is paid; it is not part of
`test`.

```console
OPENROUTER_API_KEY=… npx nx run llms:conformance-live -- --yes-paid-conformance
```

- It refuses to run without `--yes-paid-conformance` or without
  `OPENROUTER_API_KEY`.
- It reads the catalog and fails before any paid call when one of its 13
  representative models (one per lab family) is missing or has no price, or
  when the worst case — 5 calls per model of 4,096 input and 1,024 output
  tokens at the listed prices — exceeds USD 5.
- Per model it runs three stages: `structured_output` (a strict Zod schema),
  `tool_call` (one `add` call with `parallelToolCalls: false`) and
  `tool_replay` (the answer after the tool result, with the call's replay).
  Each call permits up to 1,024 output tokens.
- These pre-flight refusals throw uncaught: stdout gets no report and the
  process exits with Node's status for an uncaught error.
- Progress is written by Pino to stderr (level `LLMS_CONFORMANCE_LOG_LEVEL`,
  default `debug`; the paths `apiKey`, `authorization`, `token`, `*.apiKey`
  and `*.authorization` are redacted as `[redacted]`, so a nested `token` is
  not).
  Stdout holds only the final JSON report
  `{ ok, budgetUsd, estimatedWorstCaseUsd, results }`, where a failed result
  names its `stage` and the provider error's `error`, `provider`, `code`,
  `status`, `retryable` and `diagnostic`; the runner decides to show them.
  The exit code is 1 when any model fails.

## Build and test

Run from the repository root ([`project.json`](./project.json)):

```console
npx nx run llms:build      # tsc -p packages/llms/tsconfig.lib.json into packages/llms/dist
npx nx run llms:typecheck
npx nx run llms:test       # compiles tsconfig.spec.json into dist-tests and runs node --test
```

Tests live in [`tests/`](./tests) and use fake transports
([`tests/fakes.ts`](./tests/fakes.ts)); none reaches the network.
