# llms

One TypeScript interface for chat, streaming, tool calls, structured output,
embeddings, and reranking across model providers. Each provider factory takes
an injected HTTP transport and logger, so tests can swap in a fake transport
and hosts decide how credentials, networking, and logs are handled. Use it when
you want to call OpenAI Responses-compatible endpoints or OpenRouter without
tying the rest of your code to either.

Part of [Doric](../../README.md), whose provider bundles build on it.

## Highlights

- **One `LlmProvider` contract.** `complete`, `stream`, `embedding`, `rerank`,
  and `models` behave the same way across providers.
- **Injectable transport.** `HttpTransport` is a two-method interface;
  `createFetchTransport()` is the production default and tests pass a fake.
- **Credentials stay with the host.** Providers accept an API key or an exact
  `authorization` header, either as a string or as a function read at call
  time, so a rotated credential reaches an existing provider.
- **Structured output.** Requests can carry a Zod schema; OpenRouter validates
  and repairs direct structured output locally.
- **Multi-turn replay.** Opaque provider output, including encrypted
  reasoning, is kept for exact replay without being logged.
- **Settings-ready metadata.** `providerKinds` describes each provider's
  configuration fields so a settings UI can render them.

## Usage

```ts
import pino from 'pino';
import { createFetchTransport, createOpenAiProvider } from 'llms';

const provider = createOpenAiProvider({
  transport: createFetchTransport(),
  apiKey: process.env.OPENAI_API_KEY ?? '',
  logger: pino(),
});

for await (const event of provider.stream({
  model: 'gpt-5-fast',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Draft the next step.' },
  ],
  flags: { reasoning: { effort: 'low' } },
})) {
  // The host decides how to display structured stream events.
  console.log(event);
}
```

## Providers

### OpenAI Responses-compatible endpoints

`createOpenAiProvider` talks to any endpoint that answers the OpenAI Responses
API. Set `baseUrl` for a Responses-compatible endpoint and optionally set
`identity: { id, name }`; configured providers preserve their own identity in
events and diagnostics. The protocol is `/responses`; a Chat Completions-only
endpoint is not supported. `apiKey` is optional: without it the request carries
no authorization header, which some compatible endpoints accept.

- `*-fast` model aliases are sent without the suffix and with
  `service_tier: "priority"`.
- Requests use `store: false`. `ProviderFinished.replay` retains opaque output
  items for exact multi-turn replay, including encrypted reasoning, without
  exposing them through provider logs.
- Requests may set `toolChoice` and `parallelToolCalls`; tool results may be
  marked `incomplete`.
- Schemas are sent unchanged and marked strict only when they are already
  strict-compatible.

### OpenRouter

Use `createOpenRouterProvider` for heterogeneous OpenRouter models. It
discovers the selected model's live capabilities, applies the curated
laboratory policy, preserves opaque reasoning replay, normalizes tool controls,
and validates or repairs direct structured output locally
(`maxStructuredOutputRepairs`, two by default).

```ts
import pino from 'pino';
import { createFetchTransport, createOpenRouterProvider } from 'llms';

const provider = createOpenRouterProvider({
  transport: createFetchTransport(),
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  logger: pino(),
});
```

Set `modelsUrl` to override OpenRouter's catalog; otherwise it uses
`${baseUrl}/models`. Configuration and execution use the same endpoint.

See [MODEL_COMPATIBILITY.md](./MODEL_COMPATIBILITY.md) for the behavioral
matrix, fallback rules, primary sources, and paid live-conformance command.

### Claude integration

`createClaudeProvider` sends Anthropic Messages requests through a Claude
Code subscription login: authorize once (for example with the
`claude:oauth` script), store the resulting authorization value, and pass it
as the `authorization` dependency. `llms` never reads the credential store;
the host resolves the value.

```ts
import pino from 'pino';
import { createClaudeProvider, createFetchTransport } from 'llms';
import { resolveClaudeAuth } from 'oauth';

const credential = await resolveClaudeAuth();
const provider = createClaudeProvider({
  transport: createFetchTransport(),
  authorization: credential.authorization,
  logger: pino(),
});
```

Set `baseUrl` to point the provider at another Anthropic Messages endpoint
(default: `https://api.anthropic.com`). The provider sends the Claude Code
OAuth beta headers and the Claude Code CLI user agent, sends no thinking or
effort controls (a request `effort` is ignored, not forwarded), and answers a
stream's thinking deltas as `reasoning.delta` events. `embedding` and
`rerank` are rejected: Claude serves neither in this integration. `models()`
lists the model ids and display names Anthropic's models endpoint serves,
which is a listing only — it says nothing about a model's capabilities, so
model names are typed by hand.

### Internal Codex integration

`createCodexProvider` sends a rendered authorization header to ChatGPT's Codex
backend, not the public OpenAI Responses API. It is available to internal
callers but is not listed by `providerKinds`.

```ts
import pino from 'pino';
import { createCodexProvider, createFetchTransport } from 'llms';
import { createCodexOAuth } from 'oauth';

// tokenStore, browserOpener, and localCallbackServer are host-supplied.
const codex = createCodexOAuth({
  transport: createFetchTransport(),
  tokenStore,
  redirectUri: localCallbackServer.redirectUri,
  browserOpener,
  callbackServer: localCallbackServer,
});

const credential = await codex.credential();
const provider = createCodexProvider({
  transport: createFetchTransport(),
  authorization: credential.authorization,
  logger: pino(),
});
```

OAuth is owned by the `oauth` package. `llms` only accepts an API key rendered
as `Bearer ${apiKey}` or an exact `authorization` header supplied by the host;
passing both is an error.

### Configuring providers from settings

`providerKinds` lists the advertised kinds (`openai`, `openrouter` and
`claude`), each with the fields a settings surface should show. `providerKind(id)` looks up a
kind, and `createProviderForKind(id, values, deps)` builds a provider from
field values, rejecting missing required fields. The former `unified`,
`openai-compatible`, LM Studio adapters and raw OpenRouter/Decisions API have
been removed.

## Embeddings

OpenAI and OpenRouter providers accept an optional positive-integer
`dimensions` value for models that support a configurable embedding size.

```ts
const { embedding, usage } = await provider.embedding({
  model: 'voyageai/voyage-4-large',
  input: 'A document to embed.',
  dimensions: 1024,
});
```

The result also carries provider-reported usage when available. OpenRouter
usage includes token counts and billed cost in credits.

## Reranking

OpenAI and OpenRouter providers expose a common text-document reranking API.
The request is sent to `/rerank` below the provider's configured base URL (for
example, OpenRouter uses `https://openrouter.ai/api/v1/rerank`).

```ts
const { results, usage } = await provider.rerank({
  model: 'cohere/rerank-v3.5',
  query: 'What is the capital of France?',
  documents: [
    'Berlin is the capital of Germany.',
    'Paris is the capital of France.',
  ],
  topN: 1,
});

// [{ index: 1, relevanceScore: 0.98 }]
```

Reranking usage may include total tokens, search units, and provider-reported
cost. Providers that omit accounting data return no `usage` field.

## Structured schema on the system prompt

Structured requests may set `flags.includeStructuredSchemaOnSystemPrompt: true`
to append a deterministic system message containing the converted JSON Schema.
Authored system messages remain first and in order, followed by the generated
schema message and then all non-system messages. Omitting the flag, setting it
to `false`, or using it without `schema` leaves messages unchanged. Native
structured-output fields remain enabled for providers that support them.

## Testing with a fake transport

```ts
import pino from 'pino';
import { createOpenRouterProvider, type HttpTransport } from 'llms';

const requests = [];
const transport: HttpTransport = {
  async request(request) {
    requests.push(request);
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

## Logging and content privacy

Every provider requires a Pino logger and creates a child bound to
`{ component: 'llms', provider }`. Operational events contain counts, model
identifiers, finish reasons, and token usage, not request or response bodies.
Callers control logging through the injected logger, including disabling it.

Content privacy belongs to the caller, not this package. Error diagnostics
retain provider content without redaction, with excerpts bounded in size;
parse errors may retain their original cause. Hosts must decide how to handle
these errors before displaying, persisting, or logging them. There is no
per-request sensitive-output flag or content sanitizer.

### Migrating content policies

Remove `flags.sensitiveOutput` from requests. The `redactSecrets` and
`redactDiagnosticValue` exports have been removed; `diagnosticExcerpt` now only
truncates text. Apply any application-specific sanitization at the consumer
boundary, and configure the injected logger to control log output. Embedding
and rerank requests no longer expose `flags`, which had no other supported
behavior for those operations.

## Development

```console
npx nx build llms
npx nx typecheck llms
npx nx test llms
```

`npx nx run llms:conformance-live -- --yes-paid-conformance` runs the paid live
conformance suite described in
[MODEL_COMPATIBILITY.md](./MODEL_COMPATIBILITY.md); it is not part of `test`.
