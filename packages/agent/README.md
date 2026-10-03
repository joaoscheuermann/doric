# agent

Embeddable TypeScript agent core that composes an injected LLM provider,
message storage, executable-tool storage, and successful-tool-call storage.

The package owns agent loop control, request assembly, tool execution order,
stream events, and agent-specific lifecycle errors. Provider and tool package
errors pass through unchanged.

## Basic Usage

```ts
import { createAgent, createToolCallStorage } from 'agent';
import { createFetchTransport, createOpenAiProvider } from 'llms';
import { createMessageStorage } from 'messages';
import pino from 'pino';
import { createToolStorage, defineTool } from 'tool';
import { z } from 'zod';

const logger = pino();

const provider = createOpenAiProvider({
  transport: createFetchTransport(),
  apiKey: process.env.CODEX_API_KEY ?? '',
  logger,
});

const lookup = defineTool({
  name: 'lookup',
  description: 'Lookup indexed project context.',
  input: z.object({ query: z.string() }).strict(),
  output: z.object({ result: z.string() }).strict(),
  async execute(sandbox, { query }) {
    return { result: `context for ${query}` };
  },
});
const tools = createToolStorage([lookup(sandbox)]);

const messages = createMessageStorage();
const toolCalls = createToolCallStorage();

const agent = createAgent({
  provider,
  tools,
  messages,
  toolCalls,
  system: 'You are a concise project assistant.',
  model: 'gpt-5',
  flags: { reasoning: { effort: 'low' }, includeUsage: true },
});

const response = await agent.complete('What should I work on next?');

console.log(response.text);
console.log(messages.list());
```

`createAgent` does not create dependency defaults. The caller owns provider
credentials, tool registration, isolated message and tool-call storages, model
selection, and per-call cancellation.
The system prompt is included in provider requests but is not persisted into
external message storage.

Pass `resume: true` to `complete` or `stream` to continue the supplied message
history without appending the input again. The input still identifies the run in
`agent.started`; existing messages retain their order. The caller owns loading
durable history and supplying results for any interrupted tool calls.

Each `complete` or `stream` run may set `maxTurns` to a positive safe integer.
One turn is one provider invocation, including a direct or terminal response,
a response containing any number of tool calls, or a structured-output repair
attempt. Omitting the option preserves an unbounded loop. Invalid values throw
`TypeError` before the input is stored or the provider is called.

When the limit is reached, tools requested by the final permitted turn still
execute and their results are stored in both ledgers. The run then throws an `AgentErrorObject`
with code `turn_limit_exceeded` before another provider invocation. Streaming
preserves events already emitted but does not emit `agent.finished` for an
exhausted run.

Every run that requests structured output adds one strict terminal tool derived
from the schema, even when the caller's tool storage is empty. The schema is
never sent as a provider-native structured-output field by the agent. Ordinary
executable tool calls continue the loop; the terminal call is validated
locally, converted to the final structured response, and is never executed.
Structured runs disable parallel tool calls but leave provider tool selection
automatic. Requiring the terminal call is a runtime invariant: the agent does
not send forced `tool_choice`, because some reasoning providers cannot combine
thinking mode with forced tool selection.

An invalid terminal submission is retained only for provider replay and
ephemeral repair; no tool runs. Every rejected call receives an `incomplete`
tool result. When every Zod issue identifies a concrete primitive or missing
leaf, the agent keeps that candidate as a baseline. The next submission can
replace only those rejected paths; changes to fields that were already valid
are ignored, and the composed object is fully revalidated. If composition
fails, the whole new submission is validated normally and becomes a new
baseline only when all of its issues are also repairable leaves. Malformed
JSON, root and collection errors, and cross-field refinements use whole-object
regeneration instead.

The agent may request two corrected submissions after the initial failure.
Its transient correction names the terminal tool and reports at most ten safe
schema issues without copying rejected values. Missing, malformed,
schema-invalid, duplicate, mixed, and invalid ordinary tool-call batches share
this cumulative budget. An ordinary tool turn clears the transactional
baseline without consuming or resetting the budget. Success, exhaustion, and
run termination also discard it. The next invalid submission throws the latest
error.

`complete` and `stream` use the same repair behavior. Structured streams buffer
one provider turn until its terminal submission is classified and suppress all
provider events from a rejected turn. The final `AgentResponse.text`, final
finish, and stored assistant message serialize the object that was actually
accepted after composition; opaque provider replay remains unchanged.
`onToolCallRepair` receives safe attempt counters, and
`maxToolCallRepairs` overrides the default budget of two.

Every successfully executed and serialized tool result receives one opaque ID
from `ToolCallStorage`; `createToolCallStorage()` uses `crypto.randomUUID()` by
default and accepts an injected ID factory for deterministic tests. The record
is appended to storage; its ID and output appear in the Markdown tool-result
message; and the same record is delivered to the awaited `onToolEvent` callback
and exposed by a streamed `tool.finished` event. Empty or colliding IDs abort
the run. Rejected calls, terminal structured-output calls, thrown handlers, and
unserializable inputs or results do not create records.

## Streaming Usage

```ts
for await (const event of agent.stream('Find the current project status.')) {
  switch (event.type) {
    case 'text.delta':
      process.stdout.write(event.delta);
      break;

    case 'tool.started':
      console.log(`Calling ${event.call.name}`);
      break;

    case 'tool.finished':
      console.log(`Observation ${event.record.id}: ${event.record.output}`);
      break;

    case 'agent.finished':
      console.log(event.response.finishReason);
      break;
  }
}
```

Streaming passes through provider events and adds agent lifecycle and tool
events. Tool calls are executed sequentially in provider order, stored as tool
messages with their observation IDs, appended to tool-call storage, and the
provider loop continues until a response has no tool calls or submits a
validated terminal structured output. `complete` emits the same awaited tool
lifecycle through `onToolEvent` without exposing a stream.

## Building

Run `nx build agent` to build the library.

## Testing

Run `nx test agent` to compile and run the node:test coverage.
