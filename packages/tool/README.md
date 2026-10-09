# tools

Provider-neutral tool contracts for the TypeScript agent core.

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

`defineTool` creates an inspectable definition with Zod `input` and `output`
schemas and a neutral definition containing materialized `inputSchema` and
`outputSchema`. Its `execute(payload, call, services)` receives the validated
payload, the prompt `Call` (caller, scope, signal, trace) and the services of
the bundle that registered it; tools reach the sandbox and the host through
contracts such as `runtime.lease/v1`, never through arguments. Registering the
definition with `tools/v1` binds it (`bind(services)`, also exposed through
`bundle/contracts`'s `bindRegistrant`), and `toTool(call)` turns the bound tool
into the agent-loop `Tool`. Inputs are validated before the handler runs, and
handler results are validated before execution resolves; `isBoundTool`
recognizes a bound tool read back from `tools/v1`. Provider adapters remain responsible for converting
only supported definition fields into their native wire shape.

`createToolStorage` preserves registration order, rejects duplicate names,
parses provider tool-call arguments, validates payloads before execution, and
throws `ToolErrorObject` for structured failures.

## Building

Run `nx build tool` to build the library.

## Testing

Run `nx test tool` to compile and run the package tests.
