# tool

Typed, provider-neutral tool contracts for AI agents. Define a tool once with
Zod input and output schemas, and the package produces the JSON Schema
definition a model sees, parses and validates the model's arguments, and
validates the handler's result before anyone reads it. Bundle authors use it to
give Doric agents new capabilities; anyone building an agent loop can use it as
the tool registry.

Part of [Doric](../../README.md).

## Highlights

- **One definition, two views.** `defineTool` keeps the Zod schemas for
  validation and materializes `inputSchema` and `outputSchema` for providers.
- **Validated both ways.** Inputs are checked before the handler runs, and
  results are checked before execution resolves.
- **No ambient access.** A handler receives only its payload, the prompt
  `Call`, and its bundle's services; it reaches the sandbox and host through
  contracts such as `runtime.lease/v1`, never through arguments.
- **Structured errors.** Duplicate names, unknown tools, invalid JSON, invalid
  payloads, invalid output, and handler failures throw `ToolErrorObject` with
  a stable `code`.
- **Settings-aware.** A tool can declare the configuration fields it reads so a
  settings surface can render them.

## Usage

```ts
import { z } from 'zod';
import { createToolStorage, defineTool } from 'tool';

const lookup = defineTool({
  name: 'lookup',
  description: 'Lookup indexed context.',
  input: z.object({ query: z.string() }).strict(),
  output: z.object({ result: z.string() }).strict(),
  async execute({ query }, call, services) {
    return { result: `result for ${query}` };
  },
});

// A bundle registers the definition; tools/v1 binds it to that bundle's services.
services.use(ToolsV1).register(lookup, { alwaysAvailable: true });

// A host reads the bound tools back from tools/v1 (or binds one itself) and
// gives the agent loop the tools for one prompt call.
const bound = lookup.bind(services);
const tools = createToolStorage([bound.toTool(call)]);

const turn = await provider.complete({
  model: 'gpt-5',
  messages,
  tools: tools.definitions(),
});

for (const call of tools.calls(turn)) {
  const result = await tools.execute(call);

  messages = [
    ...messages,
    {
      role: 'tool',
      toolCallId: call.id,
      content: JSON.stringify(result),
    },
  ];
}
```

## Defining and binding tools

`defineTool` creates an inspectable definition with Zod `input` and `output`
schemas and a neutral definition containing materialized `inputSchema` and
`outputSchema`. The input must be a Zod object. Options:

| Option        | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `name`        | Tool name; must be unique within a `ToolStorage`.                    |
| `description` | Optional text shown to the model.                                    |
| `input`       | Zod object schema for the payload.                                   |
| `output`      | Zod schema for the handler's result.                                 |
| `execute`     | `(payload, call, services)` handler.                                 |
| `strict`      | Marks the definition strict; `true` by default.                      |
| `settings`    | Configuration fields (`ConfigField`) the tool reads; empty if unset. |

`execute(payload, call, services)` receives the validated payload, the prompt
`Call` (caller, scope, signal, trace) and the services of the bundle that
registered it. Registering the definition with `tools/v1` binds it
(`bind(services)`, also exposed through `bundle/contracts`'s `bindRegistrant`),
and `toTool(call)` turns the bound tool into the agent-loop `Tool`.
`isBoundTool` recognizes a bound tool read back from `tools/v1`. Provider
adapters remain responsible for converting only supported definition fields
into their native wire shape.

## Tool storage

`createToolStorage(tools)` preserves registration order, rejects duplicate
names, parses provider tool-call arguments, validates payloads before
execution, and throws `ToolErrorObject` for structured failures.

| Method           | Behavior                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| `definitions()`  | Neutral definitions, in registration order, for a provider request.     |
| `calls(turn)`    | Parses a provider turn's tool-call requests into `ToolCall`s.           |
| `validate(call)` | Parses and validates one call without executing it.                     |
| `get(name)`      | Looks up a registered tool.                                             |
| `execute(call)`  | Validates and runs one call; a thrown handler becomes `handler_failed`. |

`validate` is asynchronous only when the tool's own `check` is, as for a tool
that runs in another process.

The package also exports JSON helpers shared across Doric (`isRecord`,
`isJsonValue`, `asJsonObject`, `excerpt`) and the `ToolDefinitionSchema`,
`ToolMetadataSchema`, `JsonValueSchema`, and `JsonObjectSchema` Zod schemas.

## Development

```console
npx nx build tool
npx nx typecheck tool
npx nx test tool
```
