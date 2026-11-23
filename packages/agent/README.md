# agent

An embeddable TypeScript agent loop. Give it a model provider, a tool registry,
message storage and a tool-call ledger, and it runs the turn-by-turn cycle:
call the model, execute the tools it asks for, feed the results back, and stop
when the model answers. Every dependency is injected, so the same agent runs in
a bundle, a test or a script, with no CLI, daemon or UI attached
([`agent.ts`](src/lib/agent.ts)). It needs a Node runtime: the default ID
factory of the ledger imports `randomUUID` from `node:crypto`
([`tool-call-storage.ts`](src/lib/tool-call-storage.ts)), and the package
compiles against the Node types ([`tsconfig.lib.json`](tsconfig.lib.json)).

Part of [Doric](../../README.md). Its user is the
[`default`](../../bundles/runtime/default/README.md) runtime bundle, whose host
executor creates one agent per prompt of a Thread
([`executor.ts`](../../bundles/runtime/default/src/host/executor.ts)). The
host lists `agent` as a dependency
([`doric-host/package.json`](../../app/backend/doric-host/package.json)), which
is how the package reaches the host. It
depends on three workspace packages: [`llms`](../llms/README.md) (the provider
and its request, stream and error shapes), [`messages`](../messages/README.md)
(the message history) and [`tool`](../tool/README.md) (the tool registry), and
on `tslib` ([`package.json`](package.json)).

Feature docs: [Default agent](../../docs/features/default-agent.md),
[Prompt control](../../docs/features/prompt-control.md),
[Skills](../../docs/features/skills.md).

## Entry point

[`package.json`](package.json) names the package `agent`, version `0.0.1`,
`private`. It exports `./package.json` and one code entry point, `.`, an ES
module built to `dist/index.js` with its types in `dist/index.d.ts`. Inside the
workspace the `@org/source` condition resolves it to
[`src/index.ts`](src/index.ts). It exports:

| Export                                                                                                                                                                                                                 | Kind     | Home                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `createAgent`                                                                                                                                                                                                          | function | [`agent.ts`](src/lib/agent.ts)                                     |
| `createToolCallStorage`                                                                                                                                                                                                | function | [`tool-call-storage.ts`](src/lib/tool-call-storage.ts)             |
| `AgentErrorObject`                                                                                                                                                                                                     | class    | [`agent-error.ts`](src/lib/classes/agent-error.ts)                 |
| `Agent`, `AgentComplete`, `AgentStream`, `AgentOptions`, `AgentRunOptions`, `AgentResponse`, `AgentEvent`, `AgentToolEvent`, `AgentStructuredAttemptEvent`, `AgentToolCallRepairEvent`, `AgentError`, `AgentErrorCode` | types    | [`types/agent.ts`](src/lib/types/agent.ts)                         |
| `ToolCallStorage`, `ToolCallRecord`, `ToolCallStorageOptions`                                                                                                                                                          | types    | [`types/tool-call-storage.ts`](src/lib/types/tool-call-storage.ts) |

Everything under `src/lib/utils` is private.

## Usage

```ts
import { createAgent, createToolCallStorage } from 'agent';
import type { Call, Services } from 'bundle/contracts';
import { createFetchTransport, createOpenAiProvider } from 'llms';
import { createMessageStorage } from 'messages';
import pino from 'pino';
import { createToolStorage, defineTool } from 'tool';
import { z } from 'zod';

const provider = createOpenAiProvider({
  transport: createFetchTransport(),
  apiKey: process.env.OPENAI_API_KEY ?? '',
  logger: pino(),
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
// `services` are the registering bundle's services and `call` the prompt call.
// In Doric both come from the bundle runtime. Elsewhere, pass any `Services`
// object the handler needs (this one uses none) and a `Call` you build:
// `caller`, `signal`, `trace` and an optional `scope`.
declare const services: Services;
declare const call: Call;
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

for await (const event of agent.stream('Find the current project status.')) {
  if (event.type === 'text.delta') process.stdout.write(event.delta);
  if (event.type === 'tool.finished') console.log(event.record.id);
}

const { structured } = await agent.complete('Summarize the status.', {
  schema: z.object({ status: z.string(), next: z.array(z.string()) }),
});
```

## API

### `createAgent(options: AgentOptions): Agent`

Creates an agent ([`agent.ts`](src/lib/agent.ts)). It creates no dependency
defaults: the caller owns provider credentials, tool registration, the message
and tool-call storages, model selection and cancellation.

| `AgentOptions` field   | Type                                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provider`             | `LlmProvider` (`llms`)                        | Answers each turn through `complete` or `stream`. Its `metadata.id` goes to `structuredJsonSchema` (`llms`), which converts every schema the same way, `z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' })`; the id only fills the `provider` field and message prefix of its `invalid_structured_schema` errors ([`structured-output.ts`](src/lib/utils/structured-output.ts), [`structured.ts`](../llms/src/lib/providers/structured.ts)). |
| `tools`                | `ToolStorage` (`tool`)                        | Gives the tool definitions of each request and parses (`calls`), validates (`validate`) and executes (`execute`) the calls the model makes.                                                                                                                                                                                                                                                                                                                  |
| `messages`             | `MessageStorage` (`messages`)                 | The history the agent appends to with `push` and reads with `list` (for each request, and to find the answer of a resumed history); these are the only methods it calls, and it never removes a message.                                                                                                                                                                                                                                                     |
| `toolCalls`            | `ToolCallStorage`                             | The ledger that receives one record per successful tool result; the agent calls only `append` ([ledger contract](#createtoolcallstorageoptions-toolcallstorageoptions-toolcallstorage)).                                                                                                                                                                                                                                                                     |
| `system`               | `string \| (() => string \| Promise<string>)` | The system prompt. A function is called before every provider request. An empty string, given or returned by the function, sends no system message.                                                                                                                                                                                                                                                                                                          |
| `model`                | `string`                                      | Sent as the request's `model` and reported by `agent.started`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `effort`               | `ReasoningEffort` (`llms`)                    | Forwarded to every request when set.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `flags`                | `ProviderCallFlags` (`llms`)                  | Forwarded to every request when set.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `temperature`          | `number`                                      | Forwarded to every request when set.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maxOutputTokens`      | `number`                                      | Forwarded to every request when set.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maxRecordOutputChars` | `number`                                      | Most characters of a tool's output a stored `ToolCallRecord` keeps; over it, the output keeps its first characters and `capOutput`'s marker `\n… [truncated <omitted> of <total> characters]`. Unset, the record keeps the whole output. `maxToolResultChars` still caps what the model sees.                                                                                                                                                                |
| `retry`                | object, below                                 | How a retryable provider failure is asked again.                                                                                                                                                                                                                                                                                                                                                                                                             |

| `retry` field    | Default | Effect                                                    |
| ---------------- | ------- | --------------------------------------------------------- |
| `retries`        | `2`     | Retries for a retryable failure other than a network one. |
| `networkRetries` | `4`     | Retries for a `network_error` connection failure.         |
| `baseDelayMs`    | `1000`  | First wait, doubled per attempt.                          |
| `maxDelayMs`     | `30000` | Longest wait.                                             |

`createAgent` throws `TypeError('Agent retry needs non-negative retries and
delays.')` when a count is not a non-negative safe integer or a delay is not a
non-negative number; a field set to `undefined` replaces its default and so
throws too ([`run.ts`](src/lib/utils/run.ts)).

### `Agent`

```ts
interface Agent {
  readonly complete: {
    <
      Schema extends StructuredOutputSchema,
      Output = StructuredOutputValue<Schema>,
    >(
      input: string,
      options: AgentRunOptions<Output, Schema> & { readonly schema: Schema },
    ): Promise<AgentResponse<Output>>;
    <Output = JsonValue>(
      input: string,
      options?: AgentRunOptions<Output>,
    ): Promise<AgentResponse<Output>>;
  };
  readonly stream: {
    // the same two overloads, returning AsyncIterable<AgentEvent<Output>>
  };
}
```

Both members are `readonly` properties with two overloads: with `schema` set,
the `Output` type parameter is `StructuredOutputValue<Schema>` and
`AgentResponse.structured` holds it; otherwise `Output` defaults to `JsonValue`
([`types/agent.ts`](src/lib/types/agent.ts)). `AgentComplete` and `AgentStream`
are the types of the two members. `complete` is an async function, so every
failure, invalid options included, arrives as a rejected promise. `stream` is
an async generator: it validates its options and starts the run only when
iteration begins, and its failures are thrown from the iterator's `next()`
([`agent.ts`](src/lib/agent.ts), [Validation order](#validation-order)).

### `AgentRunOptions`

Per-run options of `complete` and `stream` ([`types/agent.ts`](src/lib/types/agent.ts)):

| Option                | Type                                                                                        | Default   | Effect (section below)                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `resume`              | `boolean`                                                                                   | `false`   | Continue the stored history without appending the input ([Resuming](#resuming)).                                                       |
| `maxTurns`            | `number`                                                                                    | unbounded | Most provider invocations of the run ([Turn limit](#turn-limit)).                                                                      |
| `maxToolCallRepairs`  | `number`                                                                                    | `2`       | Corrected submissions after a rejected tool-call turn, or a structured turn with no tool call ([Repairs](#repairs-of-rejected-turns)). |
| `maxToolResultChars`  | `number \| ((toolName: string) => number \| undefined)`                                     | no cap    | Most characters of one tool answer sent to the model ([Tool results](#tool-results-and-the-ledger)).                                   |
| `signal`              | `AbortSignal`                                                                               | none      | Cancels the run ([Cancellation](#cancellation)); also forwarded to provider requests.                                                  |
| `steering`            | `() => readonly string[] \| Promise<readonly string[]>`                                     | none      | User messages a caller sends the running loop ([Steering](#steering)).                                                                 |
| `beforeRequest`       | `() => readonly string[] \| Promise<readonly string[]>`                                     | none      | User messages stored right before each request ([Messages before a request](#messages-before-a-request)).                              |
| `schema`              | `StructuredOutputSchema` (`llms`, any Zod schema; it must convert to an object JSON Schema) | none      | Requests structured output ([Structured output](#structured-output)).                                                                  |
| `onToolEvent`         | `(event: AgentToolEvent) => void \| Promise<void>`                                          | none      | Awaited tool lifecycle callback, in both modes; each call is awaited before its event is yielded.                                      |
| `onToolCallRepair`    | `(event: AgentToolCallRepairEvent) => void \| Promise<void>`                                | none      | Awaited when a rejected tool-call turn, or a structured turn with no tool call, is retried.                                            |
| `onStructuredAttempt` | `(event: AgentStructuredAttemptEvent) => void \| Promise<void>`                             | none      | Awaited for each terminal structured-output submission and each structured turn with no tool call.                                     |

Every callback is awaited, and a callback that throws or rejects ends the run
with that same error ([`run.ts`](src/lib/utils/run.ts), [`run-tools.ts`](src/lib/utils/run-tools.ts)).

### `AgentResponse`

The result of `complete` and the payload of `agent.finished`
([`run.ts`](src/lib/utils/run.ts)):

```ts
interface AgentResponse<Output = JsonValue> {
  text: string;
  finishReason: FinishReason;
  usage?: UsageMetadata;
  reasoning?: ReasoningMetadata;
  refusal?: string;
  structured?: Output;
  finish: ProviderFinished<Output>; // the finish the fields above come from
}
```

`finish` is the last provider finish of the run, or one the agent builds:
for an accepted structured submission, the provider's finish with `text` set to
the JSON of the accepted candidate (the composed object when a baseline
applied), `finishReason` `'stop'`, no `toolCalls` and `structured` set ([`structured-output.ts`](src/lib/utils/structured-output.ts)); for a
resumed history that already ends in an answer, `{ text, finishReason: 'stop',
toolCalls: [] }` from the last assistant message, with no `usage`
([`run.ts`](src/lib/utils/run.ts)).

### `AgentEvent`

`stream` yields the provider's `ProviderStreamEvent`s (`llms`), with two
changes: a `response.finished` whose `finishReason` is `content_filter` has its
`toolCalls` emptied, and in a structured run the turn's events are buffered and
the finish is rewritten or the turn dropped as
[Structured output](#structured-output) states ([`agent.ts`](src/lib/agent.ts)).
It adds ([`types/agent.ts`](src/lib/types/agent.ts)):

| Event            | Fields                                                                           | When                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent.started`  | `model: string`, `input: string`                                                 | First, once per run, resumed runs included.                                                                                                                                                      |
| `agent.steered`  | `input: string`                                                                  | Once per steering message the loop stored.                                                                                                                                                       |
| `tool.started`   | `call: ToolCall`                                                                 | Before a validated call executes.                                                                                                                                                                |
| `tool.finished`  | `call: ToolCall`, `result: unknown`, `content: string`, `record: ToolCallRecord` | After its result is recorded; `content` is the text the model reads.                                                                                                                             |
| `tool.failed`    | `call: ToolCall`, `error: unknown`                                               | When the handler threw, or, for a call that succeeded, its result could not be serialized or recorded or the `maxToolResultChars` function threw ([`run-tools.ts`](src/lib/utils/run-tools.ts)). |
| `agent.finished` | `response: AgentResponse`                                                        | Last, when the run ends with an answer; never after an error.                                                                                                                                    |

The three tool events form `AgentToolEvent`, which `onToolEvent` receives in
both `complete` and `stream`.

### `AgentStructuredAttemptEvent` and `AgentToolCallRepairEvent`

```ts
interface AgentStructuredAttemptEvent {
  schemaVersion: 1;
  attempt: number; // one-based count of terminal submissions and call-less structured turns in the run
  runtimeAccepted: boolean; // the submission was accepted
  feedbackSent: boolean; // a correction follows
  diagnostic?: string; // the schema validation issues, when there are any
}

interface AgentToolCallRepairEvent {
  schemaVersion: 1;
  attempt: number; // repairs used so far, this one included
  maxAttempts: number; // the run's repair budget
}
```

Both carry only these fields: never the rejected arguments, model reasoning,
thrown values or causes ([`agent.ts`](src/lib/agent.ts)).

### `createToolCallStorage(options?: ToolCallStorageOptions): ToolCallStorage`

An isolated, process-local, append-only ledger in memory
([`tool-call-storage.ts`](src/lib/tool-call-storage.ts)):

```ts
interface ToolCallStorage {
  append(call: ToolCall, output: string): ToolCallRecord;
  list(): readonly ToolCallRecord[]; // a copy, in append order
}

interface ToolCallRecord {
  id: string; // opaque observation ID
  callId: string; // the provider's call ID
  toolName: string;
  input: string; // JSON of call.payload
  output: string; // the full serialized result
}

interface ToolCallStorageOptions {
  createId?: () => string; // default: crypto.randomUUID
}
```

`append` freezes the record. It throws `tool_call_id_invalid` when the ID is
not a string or is empty or whitespace only, `tool_call_id_collision` when the storage already holds
it, and `tool_input_serialization_failed` when the payload cannot be serialized
to JSON, with the `JSON.stringify` error as `cause` when it threw
([`tool-call-storage.ts`](src/lib/tool-call-storage.ts)).

Any object with this interface may replace it, for example a durable ledger.
The agent calls only `append`, once per successful tool result, and never
`list` ([`run-tools.ts`](src/lib/utils/run-tools.ts)). From the record it
returns, the agent reads `callId` to answer the call (the tool message's
`toolCallId`), `toolName` to choose the `maxToolResultChars` cap, and `id` and
`output` for the text the model reads ([`agent.ts`](src/lib/agent.ts),
[`run.ts`](src/lib/utils/run.ts)). An error `append` throws ends the run after a
`tool.failed` event.

### `AgentErrorObject`

```ts
class AgentErrorObject extends Error {
  readonly data: AgentError; // { code: AgentErrorCode; message: string; diagnostic?: string }
  constructor(data: AgentError, options?: ErrorOptions);
}
```

`name` is `'AgentErrorObject'` and `message` is `data.message`; the agent
throws it only for failures it owns ([`agent-error.ts`](src/lib/classes/agent-error.ts)).
Provider, tool-registry and callback errors pass through unchanged, except as
[Provider retries](#provider-retries) states. The codes:

| Code                               | Message                                                                                                                                                                                                                                                                   | Thrown when                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `concurrent_run`                   | `Agent instances do not support concurrent runs.`                                                                                                                                                                                                                         | A run starts while another is active.                                                                               |
| `turn_limit_exceeded`              | `Agent exceeded its <maxTurns>-turn limit.`                                                                                                                                                                                                                               | A turn would exceed `maxTurns`.                                                                                     |
| `invalid_structured_output`        | `Agent run ended without terminal structured output.`, `Agent terminal structured output must be the only tool call.`, `Agent terminal structured output arguments must be valid JSON.`, `Agent terminal structured output failed schema validation.` (with `diagnostic`) | An invalid submission after the repair budget is spent.                                                             |
| `output_truncated`                 | `The model reached its output limit in the middle of a tool call, so the call was not run.`                                                                                                                                                                               | A turn that finished on `length` is rejected (an invalid batch or terminal submission); the cause is the rejection. |
| `provider_refusal`                 | `The model declined to answer.` or `The model declined to answer: <refusal>`                                                                                                                                                                                              | A turn ends on `content_filter`.                                                                                    |
| `missing_provider_finish`          | `Provider stream ended without a response.finished event.`                                                                                                                                                                                                                | A `stream` turn ends with neither a finish nor an `error` event.                                                    |
| `tool_result_serialization_failed` | `Tool result could not be serialized to JSON.`                                                                                                                                                                                                                            | A handler's result cannot be serialized; `cause` is the `JSON.stringify` error when it threw.                       |
| `tool_input_serialization_failed`  | `Tool input could not be serialized to JSON.`                                                                                                                                                                                                                             | The ledger cannot serialize a call's payload; `cause` is the `JSON.stringify` error when it threw.                  |
| `tool_call_id_invalid`             | `Tool call storage produced an empty observation ID.`                                                                                                                                                                                                                     | The ID factory gives a non-string, empty or whitespace-only ID.                                                     |
| `tool_call_id_collision`           | `Tool call storage produced a duplicate observation ID.`                                                                                                                                                                                                                  | The ID factory repeats an ID.                                                                                       |

Invalid run options fail with `TypeError`: `Agent maxTurns must be a positive
safe integer.` and `Agent maxToolCallRepairs must be a non-negative safe
integer.` ([`run.ts`](src/lib/utils/run.ts)). `complete` returns them as a
rejected promise and `stream` throws them from its iterator
([`agent.ts`](src/lib/agent.ts)). A schema `llms` cannot convert to an
object JSON Schema fails at the start of the run with the `ProviderErrorObject`
`invalid_structured_schema` of `structuredJsonSchema`, which passes through
([`structured-output.ts`](src/lib/utils/structured-output.ts)). When each of
these is checked is stated under [Validation order](#validation-order).

## Behavior

### One run at a time

One agent owns one mutable history, so it runs serially: a run that starts
while another is active throws `concurrent_run`. When a run ends — by an
answer, an error, cancellation, or a `stream` whose iterator its consumer
closes with `return()` —
every tool call of an assistant turn the agent stored in that run that still
has no result is answered with an `incomplete` tool result, `Tool call did not
complete. Execution may have been interrupted.`, so the history never holds an
unanswered call; no ledger record is created for it ([`agent.ts`](src/lib/agent.ts)).
`stream` releases the agent only when its iterator finishes or its `return()`
is called: a consumer that just stops calling `next()` leaves the agent busy,
and the next run throws `concurrent_run`.

### The loop

A run appends the input as a user message (unless `resume`), takes steering,
and then repeats ([`agent.ts`](src/lib/agent.ts)):

1. Check the signal and count the turn against `maxTurns`.
2. Build the request: call `beforeRequest` and store its messages, read the
   tool definitions, call `system`, and send
   `[system prompt, structured-output instruction?, ...history]` with the
   definitions (and the terminal tool),
   `model`, `effort`, `flags`, `temperature`, `maxOutputTokens` and `signal`.
   `tools` is left out when the list is empty, and a structured request adds
   `parallelToolCalls: false`.
3. Ask the provider for one finished turn (`provider.complete` or
   `provider.stream`), with [provider retries](#provider-retries).
4. Store the assistant turn: its text (or its refusal when the text is empty),
   its tool calls and the provider's opaque `replay`.
5. With no tool calls (runs without `schema`; a structured turn is classified
   first, see [Structured output](#structured-output)), take steering once
   more; if it returns messages, go to 1, otherwise finish with the answer.
6. Validate the whole batch of calls in provider order before any handler runs
   (`tools.calls`, then `tools.validate` for each); a rejected batch is
   [repaired](#repairs-of-rejected-turns).
7. Execute the calls one by one in provider order, answering each, then take
   steering and go to 1.

A turn that ends on `content_filter` keeps none of its calls, not even
half-formed ones: it is stored without them and the run throws
`provider_refusal` ([`agent.ts`](src/lib/agent.ts), [`run.ts`](src/lib/utils/run.ts)).

### Tool results and the ledger

`complete` and `stream` share one tool path ([`run-tools.ts`](src/lib/utils/run-tools.ts)):
for each call, emit `tool.started`, execute it through `tools.execute`,
serialize the result, append the record to `toolCalls`, store the tool message,
and emit `tool.finished` with the record. A result is serialized as itself when
it is a string, as `''` when it is `undefined`, and as JSON otherwise
([`serialize.ts`](src/lib/utils/serialize.ts)). A returned value that
describes a failure, such as a non-zero exit code, is an ordinary result with
a record.

The model reads the result as a Markdown envelope, the ID and the output each
in a `text` fence of `max(3, longest backtick run inside + 1)` backticks, the
body followed by a newline when it does not end with one
([`run.ts`](src/lib/utils/run.ts)):

````md
# Tool Result

## Observation ID

```text
<record.id>
```

## Output

```text
<record.output, capped>
```
````

`maxToolResultChars` caps the output in that envelope: a number caps every
tool; a function is called each time a call is answered, with the tool's name
(`ToolCallRecord.toolName` for a result, `ToolCall.name` for a failure), and
`undefined` from it, or no option, means no cap; it is never called for an
`incomplete` answer. Length is JavaScript `.length`, in UTF-16 code units. Over
the cap, the text is `output.slice(0, cap)` followed by `\n… [truncated
<omitted> of <total> characters]`, with `omitted` = `total − cap`. The record
keeps the full output, so the cap only limits what the next turn reads. Caps
are not validated: a negative or fractional cap goes into the same `slice` and
subtraction ([`agent.ts`](src/lib/agent.ts), [`run.ts`](src/lib/utils/run.ts)).

A function that throws ends the run with its error
([`run-tools.ts`](src/lib/utils/run-tools.ts)). For a successful call the
record is already in the ledger, no tool message is stored and `tool.failed`
is emitted before the run ends; for a [failed call](#tool-failures), it ends
the run without `tool.failed`. Either way the call is answered `incomplete`
when the run ends.

Each tool event is passed to `onToolEvent`, awaited, and only then yielded by
`stream`. A `tool.finished` callback that throws ends the run with its error
and emits no `tool.failed`; the result is already recorded and answered
([`run-tools.ts`](src/lib/utils/run-tools.ts)).

Rejected calls, terminal structured-output calls, failed calls and results
that cannot be serialized create no record ([`run-tools.ts`](src/lib/utils/run-tools.ts)).

### Tool failures

A call whose `tools.execute` rejects (a handler's error, wrapped in
`handler_failed`, or the registry's own, such as `invalid_output`, which
arrives unwrapped) does not end the run, and the agent never executes the
call again. The call is answered with a failure envelope that has no
observation ID, the batch goes on, and `tool.failed` is emitted after the
answer is stored, so a callback error never leaves the call unanswered
([`run-tools.ts`](src/lib/utils/run-tools.ts), [`run.ts`](src/lib/utils/run.ts)):

````md
# Tool Failure

The tool call failed and returned no result.

## Error

```text
<description, capped>
```
````

The description is what `tools.execute` rejected with and each cause under it,
one per line, outermost first, the lines after the first prefixed `Caused by: `
([`serialize.ts`](src/lib/utils/serialize.ts)). The tool registry's
`handler_failed` wrapper only says that the handler threw, so when it has a
`cause` the chain starts at that cause. A line reads `<code>: <message>` when
the level is an `Error` with a code (a string `code` property, else a string
`data.code`); other levels carry no code. An `Error`'s message is trimmed, or
its `name` when empty; a string is itself; anything else is its JSON, or
`String(value)` when `JSON.stringify` cannot encode it. At most eight levels
are read, and the chain stops at a level it has already visited. An empty
message, or one an earlier line already contains, adds no line; when no line
remains, the description is `The tool failed without a message.` The same
`maxToolResultChars` cap applies.

The model then corrects the call, works around it or reports it; `maxTurns`
bounds a model that keeps calling a failing tool. Besides a cap function that
throws (above), three failures end the run instead, each after `tool.failed`:
a call that rejects while the run's signal is aborted (with that error), a
result that cannot be serialized, and a record the ledger refuses
([`run-tools.ts`](src/lib/utils/run-tools.ts)).

### Repairs of rejected turns

A turn is rejected before any tool runs when its batch fails validation (invalid
JSON, unknown tool, invalid payload) or when a structured run's
[terminal submission](#structured-output) is invalid ([`agent.ts`](src/lib/agent.ts)).
The rejected turn is stored for provider replay, every call in it is answered
with an `incomplete` result `Tool call rejected before execution. Correct the
call and try again.`, and a correction is stored as a user message after them,
so the next request ends on it and the system prompt stays the same on every
request ([`run.ts`](src/lib/utils/run.ts)). The correction of a rejected batch
is:

```md
# Tool call correction

The previous tool-call response was rejected before any tool ran.
Call only available tools and pass valid JSON arguments matching their schemas.
```

Every rejected turn is stored and its calls are answered `incomplete` before
the `length` and budget checks below, so this also happens when the run throws
([`agent.ts`](src/lib/agent.ts)).

Both kinds share one cumulative budget per run, `maxToolCallRepairs` (default
`2`; [`agent.ts`](src/lib/agent.ts), [`run.ts`](src/lib/utils/run.ts)): each
repair awaits `onToolCallRepair` with the repairs used so far and the budget.
Once it is spent, the next rejection throws its error: the tool registry's
error for a batch, the latest `invalid_structured_output` for a submission.
Ordinary tool turns neither use nor reset the budget. A rejected turn that
finished on `length` is not repaired: it throws `output_truncated` with the
rejection as its cause. A handler's failure is never part of this path.

### Structured output

With `schema` set, every request offers one strict terminal tool derived from
the schema, even when the tool storage is empty
([`structured-output.ts`](src/lib/utils/structured-output.ts)). Its name is
`submit_structured_output`, or `submit_structured_output_2`, `_3` and so on
when a caller tool holds the name at the start of the run (the name is chosen
once, from the definitions read then); its description is `Submit the
final structured output and end the agent run.`; its input schema is
`z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw' })`, the one
conversion `structuredJsonSchema` of `llms` applies for every provider (the
provider id only names its `invalid_structured_schema` errors)
([`structured.ts`](../llms/src/lib/providers/structured.ts)); its output
schema is `{ not: {} }` and the definition is `strict: true`. The request
also carries a system message after the system prompt (the only one when the
prompt is empty):

> When the task is complete, call `<name>` exactly once with the final
> structured output. That call must be the only tool call in its response. Do
> not return the final output as ordinary text.

The schema is never sent as a provider-native structured-output field. Structured
requests set `parallelToolCalls: false` but leave tool selection automatic: the
agent never forces `tool_choice`, because some reasoning providers cannot
combine thinking with forced tool selection ([`agent.ts`](src/lib/agent.ts)).

Each turn that does not end on `content_filter` is classified
([`structured-output.ts`](src/lib/utils/structured-output.ts), [`agent.ts`](src/lib/agent.ts)):

- ordinary calls only: they run through the normal loop;
- no call at all: invalid, `Agent run ended without terminal structured output.`;
- the terminal call more than once, or with other calls: invalid,
  `Agent terminal structured output must be the only tool call.`;
- arguments that are not JSON: invalid,
  `Agent terminal structured output arguments must be valid JSON.`;
- arguments that fail the Zod schema: invalid,
  `Agent terminal structured output failed schema validation.`, with a
  `diagnostic`;
- arguments that pass: accepted.

The terminal call is never executed and gets no tool result. An accepted
submission becomes a tool-free finish with `finishReason: 'stop'`,
`text` set to the JSON of the accepted candidate (the composed object when the
composition passed) and `structured` to the schema's parsed output; it is stored
as the final assistant message, with the provider's `replay` unchanged, and
returned ([`structured-output.ts`](src/lib/utils/structured-output.ts),
[`agent.ts`](src/lib/agent.ts)).

The `diagnostic` lists the first ten Zod issues, each as:

```text
- Field: <path segments joined with ".", or <root>>
  Kind: <issue code>
  Expected: <expected>
  Problem: <first line of the Zod message>
  <each further line of the message, indented>
```

The `Expected:` line appears only when Zod gives a string. Whitespace runs in
the issue code become `_`; each message line has its whitespace collapsed to
single spaces, and empty lines are dropped. It never copies the rejected
value. The correction of an invalid submission
is stored as a user message ([`structured-output.ts`](src/lib/utils/structured-output.ts)):

```md
# Structured output correction

The previous response was rejected: <error message>

Submit the corrected final output by calling `<name>` exactly once. That call must be the only tool call in its response.

<guidance>

# Validation issues

<diagnostic>
```

The last three blocks appear only when the error has a diagnostic
([`structured-output.ts`](src/lib/utils/structured-output.ts)). Without a
baseline, `<guidance>` is `Correct every validation issue listed below.
Preserve fields that already satisfy the schema. Do not encode objects or
arrays as JSON strings.` With one, it is `Only the following rejected paths
will be applied to the previous candidate: <paths>. Changes to every other
path will be ignored. Do not encode objects or arrays as JSON strings.`, the
paths written as `a.b[0]` and separated by `, `.

**Transactional baseline.** When every issue of a schema-invalid submission is
repairable, the submission is kept as a baseline with the issues' paths, and
the correction names those paths: only they are applied to the previous
candidate, and changes elsewhere are ignored
([`structured-output.ts`](src/lib/utils/structured-output.ts), [`agent.ts`](src/lib/agent.ts)).
An issue is repairable when its code is not `custom`, its path is non-empty
and made only of string or number keys, and its parent exists in the
submission. Either the value there is `null`, a string, a number or a boolean
and the issue's `expected` is not `object`, `array` or `record`; or the key is
a missing string key whose `expected` is `string`, `number`, `boolean` or
`null`. Paths are deduplicated.

The next valid-JSON single terminal submission is composed with the baseline:
for each baseline path whose parent exists in the new submission, the new
value replaces the baseline's. A key the new submission omits is removed from
an object (an array keeps its item). A path whose parent the new submission
lacks keeps the baseline value. The composed object is validated in full and
accepted when it passes. If it fails, the new submission is validated on its
own: a new submission that is valid on its own is accepted; otherwise it
becomes the new baseline only when all its issues are repairable, and else no
baseline is kept and the correction asks for the whole object again. Every
other invalid kind (no call, a mixed turn, invalid JSON) discards the
baseline, as do an ordinary tool turn, success, exhaustion and the end of the
run ([`structured-output.ts`](src/lib/utils/structured-output.ts)).

**`onStructuredAttempt`.** Each terminal submission and each structured turn
with no tool call, accepted or invalid, awaits it once: accepted with
`runtimeAccepted: true, feedbackSent: false`; invalid with
`feedbackSent: true` when a correction follows, or `false` when the budget is
spent and the run throws; `diagnostic` when the submission had one. It is
called before `onToolCallRepair`. A submission cut by `length` throws
`output_truncated` without calling it. A callback that fails ends the run with
its error before any further provider request ([`agent.ts`](src/lib/agent.ts)).

**Streaming.** `stream` buffers the events of every structured turn until the
turn is classified: an accepted or ordinary turn's events are then yielded,
its `response.finished` carrying the accepted finish; a rejected turn's events
are dropped. A run that ends on a refusal or a provider `error` yields its
buffered events before throwing. Every other failure drops them: an
`output_truncated` turn, a spent repair budget, an abort, a thrown provider
error, `missing_provider_finish`, and a failing `onStructuredAttempt` or
`onToolCallRepair` ([`agent.ts`](src/lib/agent.ts)).

### Resuming

`resume: true` continues the stored history without appending the input; the
input still names the run in `agent.started`, and the stored order is kept
([`agent.ts`](src/lib/agent.ts)). The caller owns loading durable history and
answering interrupted calls. A resumed run without `schema` whose history,
after steering, ends in an assistant turn with no tool calls finishes with that
turn (`finishReason: 'stop'`, its text parts joined) without a provider call,
because asking again would send a trailing assistant turn, which current
models refuse as prefill ([`run.ts`](src/lib/utils/run.ts)).

### Steering

`steering` takes the messages a caller sent the running loop since it last
asked ([`agent.ts`](src/lib/agent.ts)). The loop calls it:

- before the first turn of every run, after the input is stored;
- after every executed tool batch;
- once more when an ordinary (unstructured) turn answers without tool calls,
  so a message that arrives while the model writes its final answer continues
  the run.

Each returned string is stored as a user message before the next turn, and
`stream` emits one `agent.steered` per message. The loop checks the signal
before calling it, and never calls it when `maxTurns` leaves no turn or when a
structured run submits its result; those messages stay with the caller
([`agent.ts`](src/lib/agent.ts)).

### Messages before a request

`beforeRequest` is called once before every provider request, repair turns
included, after the turn is counted and the signal checked, and before the
loop reads the tool definitions, the system prompt and the history, so a tool
the message makes visible is offered in that same request
([`agent.ts`](src/lib/agent.ts)). Each returned string is stored in order as a
user message at the end of the history, after every tool result of the last
batch. Unlike `steering`, it emits no `agent.steered`, uses no turn and never
makes a finished run continue: it is not called when no request follows. A
rejection ends the run with its error; messages already stored stay.

### Turn limit

`maxTurns` must be a positive safe integer, or the run throws `TypeError`
before the input is stored or the provider is called; omitted, the loop is
unbounded ([`run.ts`](src/lib/utils/run.ts)). One turn is one provider turn,
its [retries](#provider-retries) included: a direct answer, a turn with any
number of tool calls, or a repair attempt, counted the same in `complete` and
`stream` ([`agent.ts`](src/lib/agent.ts)). The tools of the last
permitted turn still execute and their results are stored in both the history
and the ledger; the next turn then throws `turn_limit_exceeded` before the
provider is called. A stream keeps the events it already yielded and does not
emit `agent.finished`.

### Validation order

`maxTurns` is checked first, before the run takes the agent, stores the input
or calls the provider ([`agent.ts`](src/lib/agent.ts)). The schema conversion
and `maxToolCallRepairs` come later, and their order differs by mode:

- `stream`: after the input is stored, before `agent.started` and before
  steering is taken.
- `complete`: after the input is stored and steering is taken; not at all when
  a resumed history is already answered.

In both modes the schema conversion runs before `maxToolCallRepairs`. Either
failure ends the run before any provider turn, so no call is pending
([`agent.ts`](src/lib/agent.ts)).

### Provider retries

A provider failure marked `retryable` (read by shape from a thrown value's
`data` object, or from the value itself when it has none, or from a stream
`error` event's `error`; only `retryable: true` counts, and `code` and
`retryAfterMs` are read from the same object) that comes before any output is
asked again ([`agent.ts`](src/lib/agent.ts), [`run.ts`](src/lib/utils/run.ts)).
Each kind has its own budget per turn: `retry.networkRetries` for a
`network_error`, `retry.retries` for any other. The wait is the error's
`retryAfterMs` when it is a finite non-negative number, else
`baseDelayMs × 2^attempt`, where `attempt` is the 0-based index of the failed
attempt in the turn, counted across both kinds; the wait is never longer than
`maxDelayMs`; an aborted signal ends the wait with its
reason, and no retry starts once the signal is aborted. In `stream`, the
`response.started` and `usage` events of an attempt are held until its first
output, so a retried attempt leaves no trace; a turn that already streamed
output is never retried. A thrown error that is not retried first yields the
held `response.started` and `usage` events of that last attempt (in a
structured run they join the turn's buffer and are dropped with it).

A thrown error whose `data.code` is `network_error` and that runs out of
retries after at least one retry of either kind throws a `ProviderErrorObject`
that keeps every `data` field of the original (`code`, `provider`,
`retryable`) and replaces only `message`, with
`Could not connect to <provider> (tried N times).`, N counting every attempt
of the turn; its cause is the original error's `cause`, or the
original error when it has none ([`run.ts`](src/lib/utils/run.ts)). With no
retry made (for example `networkRetries: 0`) the original error is thrown.
This wrapping applies only to thrown errors: a stream `error` event that is
not retried, whether or not earlier attempts were, is yielded unchanged, and a
stream that then ends without a finish throws that error as a
`ProviderErrorObject` ([`agent.ts`](src/lib/agent.ts)).

### Cancellation

The run checks `signal` before every turn, before calling `steering`, after
building each request, on every streamed event, after each provider answer,
before each tool starts, and after every awaited callback and every yielded
event ([`agent.ts`](src/lib/agent.ts), [`run-tools.ts`](src/lib/utils/run-tools.ts)).
An aborted run throws the signal's reason, or the error the provider or a
handler threw once the signal was aborted (such an error is never retried); a
provider answer received after the
abort is stored first, and its unanswered calls get `incomplete` results when
the run ends. The agent does not interrupt a running handler: `tools.execute`
gets no signal, so a handler cannot see the cancellation; the agent lets it
settle, then starts no further tool or provider turn.

## Development

```console
npx nx build agent
npx nx typecheck agent
npx nx test agent
```

`build`, `build-deps` and `typecheck` come from the `@nx/js/typescript`
plugin ([`nx.json`](../../nx.json), [`tsconfig.lib.json`](tsconfig.lib.json)).
`typecheck` checks [`tsconfig.json`](tsconfig.json), which references only
`tsconfig.lib.json`, so the tests are type-checked only by `test`'s `tsc`.
`test`, in [`project.json`](project.json), builds the dependencies, compiles
[`tsconfig.spec.json`](tsconfig.spec.json) (`src` and `tests`) to `dist-tests`
and runs its `node:test` suite (`tests/*.test.ts`), which uses the provider
and tool fakes in [`tests/fakes.ts`](tests/fakes.ts).
