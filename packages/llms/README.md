# llms

Provider-neutral model and streaming boundaries for Doric's TypeScript
agent core. The package keeps provider credentials and HTTP injected so tests
can use fakes and host surfaces can own sensitive behavior.

## Unified OpenRouter provider

Use `createUnifiedProvider` for heterogeneous OpenRouter models. It discovers
the selected model's live capabilities, applies the curated laboratory policy,
preserves opaque reasoning replay, normalizes tool controls, and validates or
repairs direct structured output locally.

```ts
import pino from 'pino';
import { createFetchTransport, createUnifiedProvider } from 'llms';

const provider = createUnifiedProvider({
  transport: createFetchTransport(),
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  logger: pino(),
});
```

See [MODEL_COMPATIBILITY.md](./MODEL_COMPATIBILITY.md) for the behavioral
matrix, fallback rules, primary sources, and paid live-conformance command.

## OpenRouter with an API key

```ts
import pino from 'pino';
import { createFetchTransport, createOpenRouterProvider } from 'llms';

const provider = createOpenRouterProvider({
  transport: createFetchTransport(),
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  logger: pino(),
});

const result = await provider.complete({
  model: 'openai/gpt-5',
  messages: [{ role: 'user', content: 'Summarize the plan.' }],
  tools: [
    {
      name: 'lookup',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
});
```

### Jev decisions

Jev is a System One decision model rather than a chat model. Use the raw
OpenRouter provider's typed `decide` method, which calls OpenRouter's Decisions
API with the same injected transport and API key.

```ts
const result = await provider.decide({
  model: '~typesafe/jev-latest',
  state: 'Help! My payouts have been failing for 3 days.',
  questions: {
    isUrgent: {
      type: 'noul',
      instructions: 'Does this message convey urgency?',
      criteria: {
        true: 'Explicitly time-sensitive',
        false: 'No urgency expressed',
      },
    },
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      criteria: {
        billing: 'Payments, invoicing, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing, upgrades, new accounts',
      },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm', 'Frustrated', 'Very angry'],
    },
  },
});

if (
  result.answers.isUrgent.noul > 0.8 &&
  result.answers.department.choice === 'billing'
) {
  // Escalate to billing.
}
```

Each question is inferred independently: Noul answers expose `noul`, Choice
answers expose `choice`, `probabilities`, and `confidence`, and Score answers
expose `score`, `legend`, `probabilities`, and `confidence`. State,
instructions, and criteria may contain strings or structured JSON.

## OpenAI with an API key

```ts
import pino from 'pino';
import { createFetchTransport, createOpenAiProvider } from 'llms';

const provider = createOpenAiProvider({
  transport: createFetchTransport(),
  apiKey: process.env.CODEX_API_KEY ?? '',
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

`*-fast` OpenAI model aliases are sent to the Responses API without the
suffix and with `service_tier: "priority"`.

OpenAI Responses requests use `store: false`. `ProviderFinished.replay`
retains opaque output items for exact multi-turn replay, including encrypted
reasoning, without exposing them through provider logs. Requests may set
`toolChoice` and `parallelToolCalls`; tool results may be marked `incomplete`.
Schemas are sent unchanged and marked strict only when they are already
strict-compatible.

## Embeddings

OpenAI, OpenRouter, and LM Studio OpenAI-compatible providers accept an
optional positive-integer `dimensions` value for models that support a
configurable embedding size.

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

OpenAI, OpenRouter, and LM Studio OpenAI-compatible providers expose a common
text-document reranking API. The request is sent to `/rerank` below the
provider's configured base URL (for example, OpenRouter uses
`https://openrouter.ai/api/v1/rerank`).

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

Structured requests may set
`flags.includeStructuredSchemaOnSystemPrompt: true` to append a deterministic
system message containing the converted JSON Schema. Authored system messages
remain first and in order, followed by the generated schema message and then
all non-system messages. Omitting the flag, setting it to `false`, or using it
without `schema` leaves messages unchanged. Native structured-output fields
remain enabled for providers that support them.

## Codex with a rendered authorization header

```ts
import pino from 'pino';
import { createCodexProvider, createFetchTransport } from 'llms';
import { createCodexOAuth } from 'oauth';

const codex = createCodexOAuth({
  transport: createFetchTransport(),
  tokenStore,
  clientId: 'client-id',
  redirectUri: 'http://127.0.0.1:3000/callback',
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
as `Bearer ${apiKey}` or an exact `authorization` header supplied by the host.
The Codex provider sends that authorization header to ChatGPT's Codex backend,
not the public OpenAI Responses API.

## Fake transport tests

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
`redactDiagnosticValue` exports have been removed; `diagnosticExcerpt` now
only truncates text. Apply any application-specific sanitization at the
consumer boundary, and configure the injected logger to control log output.
Embedding and rerank requests no longer expose `flags`, which had no other
supported behavior for those operations.

## Building

Run `nx build llms` to build the library.

## Testing

Run `nx test llms` to compile and run the package tests.
