# agent

An embeddable TypeScript agent loop. Give it a model provider, a tool registry,
and message storage, and it runs the turn-by-turn cycle: call the model,
execute the requested tools, feed the results back, and stop when the model
answers. Every dependency is injected, so the same agent runs in a desktop
host, a test, or a script, with no CLI, daemon, or UI attached.

Part of [Doric](../../README.md), where it drives every Thread's prompt.

## Highlights

- **Provider-neutral.** Works with any `LlmProvider` from `llms`; provider and
  tool errors pass through unchanged.
- **Streaming or awaited.** `stream` yields provider events plus agent and tool
  lifecycle events; `complete` returns the final response and reports the same
  tool lifecycle through a callback.
- **Structured output with repair.** Pass a Zod schema and the agent collects a
  validated object through a terminal tool, asking the model to fix only the
  fields that failed.
- **Steerable and resumable.** Inject user messages into a run in flight, or
  continue a stored history without repeating the input.
- **Bounded.** Cap provider turns, repair attempts, and how much of a tool
  result reaches the model.
- **Auditable tool results.** Every successful tool call gets an opaque ID in a
  tool-call ledger that tests can make deterministic.

## Usage

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
  apiKey: process.env.OPENAI_API_KEY ?? '',
  logger,
});

const lookup = defineTool({
  name: 'lookup',
  description: 'Lookup indexed project context.',
  input: z.object({ query: z.string() }).strict(),
  output: z.object({ result: z.string() }).strict(),
  async execute({ query }, call, services) {
    return { result: `context for ${query}` };
  },
});
// `services` are the registering bundle's services and `call` the prompt call
// (in Doric both come from the bundle runtime).
const tools = createToolStorage([lookup.bind(services).toTool(call)]);

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

### Streaming

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

Streaming passes through provider events and adds the agent lifecycle
(`agent.started`, `agent.steered`, `agent.finished`) and tool events
(`tool.started`, `tool.finished`, `tool.failed`). `complete` emits the same
awaited tool lifecycle through `onToolEvent` without exposing a stream.

## API

| Export                           | Purpose                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `createAgent(options)`           | Creates an agent from `provider`, `tools`, `messages`, `toolCalls`, `system`, and `model`.   |
| `agent.complete(input, options)` | Runs to completion and resolves an `AgentResponse`.                                          |
| `agent.stream(input, options)`   | Runs and yields `AgentEvent`s.                                                               |
| `createToolCallStorage(options)` | Creates an in-memory ledger of successful tool results; `createId` overrides the ID factory. |
| `AgentErrorObject`               | Agent lifecycle errors, such as `turn_limit_exceeded`, `concurrent_run`, or ID collisions.   |

`AgentOptions` also accepts `effort`, `flags`, `temperature`, and
`maxOutputTokens`, which are forwarded to provider requests.

Per-run options for `complete` and `stream`:

| Option                | Effect                                                                     |
| --------------------- | -------------------------------------------------------------------------- |
| `resume`              | Continue the stored history without appending the input again.             |
| `steering`            | Supplies user messages to insert into the run in flight.                   |
| `maxTurns`            | Bounds provider invocations; unbounded when omitted.                       |
| `maxToolCallRepairs`  | Overrides the default budget of two corrected submissions.                 |
| `maxToolResultChars`  | Caps the characters of one tool result sent to the model; no cap if unset. |
| `schema`              | Requests structured output validated against the schema.                   |
| `signal`              | Cancels the run.                                                           |
| `onToolEvent`         | Awaited callback for `tool.started`, `tool.finished`, and `tool.failed`.   |
| `onToolCallRepair`    | Receives safe attempt counters when a tool-call turn is retried.           |
| `onStructuredAttempt` | Receives safe evidence for each terminal structured-output submission.     |

## Behavior

### Ownership

`createAgent` does not create dependency defaults. The caller owns provider
credentials, tool registration, isolated message and tool-call storages, model
selection, and per-call cancellation. The system prompt is included in provider
requests but is not persisted into external message storage.

One agent owns one mutable message history, so it runs serially: starting a
second run while one is active throws `AgentErrorObject` with code
`concurrent_run`. When a run ends, any tool call still without a result is
answered with an `incomplete` tool result.

### The loop

Tool calls are executed sequentially in provider order, stored as tool messages
with their observation IDs, appended to tool-call storage, and the provider
loop continues until a response has no tool calls or submits a validated
terminal structured output.

### Resuming

Pass `resume: true` to `complete` or `stream` to continue the supplied message
history without appending the input again. The input still identifies the run
in `agent.started`; existing messages retain their order. The caller owns
loading durable history and supplying results for any interrupted tool calls.

### Steering

Pass `steering` to let a caller correct a run in flight. The loop calls it
before the first turn of a resumed run, after every executed tool batch, and
once more before an ordinary run would finish, and stores each returned message
as a user message before its next provider turn; streaming emits one
`agent.steered` event per message. A message that arrives while the model
writes its final answer therefore continues the run. The loop never asks when
no turn is left or when a structured run submits its result, so those messages
stay with the caller.

### Turn limits

Each `complete` or `stream` run may set `maxTurns` to a positive safe integer.
One turn is one provider invocation, including a direct or terminal response,
a response containing any number of tool calls, or a structured-output repair
attempt. Omitting the option preserves an unbounded loop. Invalid values throw
`TypeError` before the input is stored or the provider is called.

When the limit is reached, tools requested by the final permitted turn still
execute and their results are stored in both ledgers. The run then throws an
`AgentErrorObject` with code `turn_limit_exceeded` before another provider
invocation. Streaming preserves events already emitted but does not emit
`agent.finished` for an exhausted run.

### Structured output

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

The agent may request two corrected submissions after the initial failure. Its
transient correction names the terminal tool and reports at most ten safe
schema issues without copying rejected values. Missing, malformed,
schema-invalid, duplicate, mixed, and invalid ordinary tool-call batches share
this cumulative budget. An ordinary tool turn clears the transactional baseline
without consuming or resetting the budget. Success, exhaustion, and run
termination also discard it. The next invalid submission throws the latest
error.

`complete` and `stream` use the same repair behavior. Structured streams buffer
one provider turn until its terminal submission is classified and suppress all
provider events from a rejected turn. The final `AgentResponse.text`, final
finish, and stored assistant message serialize the object that was actually
accepted after composition; opaque provider replay remains unchanged.
`onToolCallRepair` receives safe attempt counters, and `maxToolCallRepairs`
overrides the default budget of two.

### Tool-call records

Every successfully executed and serialized tool result receives one opaque ID
from `ToolCallStorage`; `createToolCallStorage()` uses `crypto.randomUUID()` by
default and accepts an injected ID factory for deterministic tests. The record
is appended to storage; its ID and output appear in the Markdown tool-result
message; and the same record is delivered to the awaited `onToolEvent` callback
and exposed by a streamed `tool.finished` event. Empty or colliding IDs abort
the run. Rejected calls, terminal structured-output calls, thrown handlers, and
unserializable inputs or results do not create records.

### Tool failures

A handler that throws does not end the run. The run emits `tool.failed` and
answers the call with a Markdown failure message: what the handler threw and
each cause under it, one per line, with their codes, starting below the tool
registry's `handler_failed` wrapper. The run then continues, so the model can
correct the call, work around it or report it. Set `maxTurns` to bound a model
that keeps calling a failing tool. A handler that fails after the run's signal
is aborted ends the run with its error, and so does a result that cannot be
serialized or recorded.

## Development

```console
npx nx build agent
npx nx typecheck agent
npx nx test agent
```

`test` compiles the package and runs its `node:test` suite.
