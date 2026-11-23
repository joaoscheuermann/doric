# tool

`tool` is Doric's package for typed, provider-neutral agent tools. A tool is
defined once, with a Zod schema for its input and one for its result. The
package then derives the JSON Schema definition a model sees, parses and
validates the arguments a model sends, runs the handler, and validates the
handler's result before any caller reads it. It also holds the JSON value types,
schemas and helpers the other model-facing packages share.

Part of [Doric](../../README.md). The contract through which bundles register
and list tools, `tools/v1` (version 1.4.0), belongs to
[`bundle`](../bundle/README.md) and is provided by
[`core`](../../bundles/foundation/core/README.md); every mention of `tools/v1`
below means that version. This README is the home of the package's exports.

## Who uses it

| Kind     | Users                                                                                                                                                                                                                                                                                                                             | What they use                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Bundles  | The bundles that give agents tools: [`files`](../../bundles/features/files/README.md), [`threads`](../../bundles/features/threads/README.md) and [`comments`](../../bundles/features/comments/README.md)                                                                                                                          | `defineTool`                                                                                                                     |
| Bundles  | [`git`](../../bundles/features/git/README.md), [`terminal`](../../bundles/features/terminal/README.md) and [`web`](../../bundles/features/web/README.md)                                                                                                                                                                          | `defineTool`, `ToolDefinitionObject`                                                                                             |
| Bundles  | [`mcp`](../../bundles/features/mcp/README.md): one tool per server tool, with the server's input schema                                                                                                                                                                                                                           | `defineTool`, `ToolDefinitionObject`, `ToolErrorObject`, `asJsonObject`                                                          |
| Bundles  | [`runtime/default`](../../bundles/runtime/default/README.md): its executor turns the tools `tools/v1` lists into one prompt's tool storage and resolves their settings; its `load_skill` tool is a `defineTool` tool                                                                                                              | `isBoundTool`, `BoundTool`, `createToolStorage`, `ToolStorage`, `Tool`, `ToolErrorObject`, `ToolConfig`, `defineTool`, `excerpt` |
| Bundles  | [`host-config`](../../bundles/foundation/host-config/README.md) checks the settings fields the registered tools declare before it stores a configuration                                                                                                                                                                          | `isBoundTool`, `BoundTool`, `ToolConfig`                                                                                         |
| Packages | [`agent`](../agent/README.md): the agent loop takes a `ToolStorage` and runs its `ToolCall`s                                                                                                                                                                                                                                      | `ToolStorage`, `ToolCall`, `ToolDefinition`, `isRecord`                                                                          |
| Packages | [`llms`](../llms/README.md): provider requests carry `ToolDefinition`s, provider turns carry `ToolCallRequest`s                                                                                                                                                                                                                   | `ToolDefinition`, `ToolCallRequest`, the JSON types, `isRecord`, `asJsonObject`                                                  |
| Tools    | [`tool-okf`](../../tools/okf/README.md): the `okf_search` tool definition                                                                                                                                                                                                                                                         | `defineTool`, `isRecord`                                                                                                         |
| Apps     | [`doric-host`](../../app/backend/doric-host/README.md) passes `ToolErrorObject` to `startKernel`'s `errorClasses`, so the kernel process rebuilds a `ToolErrorObject` it receives from another process with its class (see [Errors](#errors-toolerrorobject)) ([`boot.ts`](../../app/backend/doric-host/src/lib/bundles/boot.ts)) | `ToolErrorObject`                                                                                                                |

## Entry point

[`package.json`](package.json) has one entry, `.` (`import … from 'tool'`), and
exposes `./package.json`. The `@org/source` condition resolves it to
[`src/index.ts`](src/index.ts) inside the workspace; `types` and `import`
resolve to the built `dist/index.d.ts` and `dist/index.js`. The package is an
ES module and depends on `bundle` (for `bundle/contracts`), `zod` and `tslib`.
[`src/index.ts`](src/index.ts) re-exports every module listed below.

## Usage

```ts
import { z } from 'zod';
import { ToolsV1 } from 'bundle/contracts';
import { createToolStorage, defineTool, isBoundTool } from 'tool';

const lookup = defineTool({
  name: 'lookup',
  description: 'Look up indexed context.',
  input: z.object({ query: z.string() }).strict(),
  output: z.object({ result: z.string() }).strict(),
  async execute({ query }, call, services) {
    return { result: `result for ${query}` };
  },
});

// In a bundle's activation: tools/v1 binds the definition to this bundle's services.
services.use(ToolsV1).register(lookup, { alwaysAvailable: true });

// In a runtime, for one prompt call: the listed tools become the prompt's storage.
const storage = createToolStorage(
  services
    .use(ToolsV1)
    .list(call)
    .map(({ tool }) => tool)
    .filter(isBoundTool) // this example's choice; the default runtime fails the run instead
    .map((tool) => tool.toTool(call)),
);

const request = { tools: storage.definitions() }; // what the provider sends the model
for (const toolCall of storage.calls(turn)) {
  const result = await storage.execute(toolCall); // validated input, validated result
}
```

## Defining a tool: `defineTool`

```ts
defineTool<Input extends ToolInput, Output extends ToolOutput, Deps = Services>(
  options: DefineToolOptions<Input, Output, Deps>,
): ToolDefinitionObject<Input, Output, Deps>
```

`Deps` is what `execute` receives as its third argument, passed by
`bind(deps)`. It defaults to the kernel `Services`, so existing tools compile
unchanged; nothing changes at run time. A tool for a host part names a small
port object (or `unknown`) as `Deps` and is bound by its owner before
`createToolHandlers().register`; this is how a tool slice rebinds a kernel tool
to router clients.

`ToolInput` is `z.ZodObject`; `ToolOutput` is `z.ZodType`
([`types/tool.ts`](src/lib/types/tool.ts)).

### Options (`DefineToolOptions`)

| Option             | Type                                                                                                | Default              | Meaning                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | `string`                                                                                            | required             | The tool's name, as the model calls it.                                                                                                                        |
| `description`      | `string`                                                                                            | absent               | Text shown to the model.                                                                                                                                       |
| `input`            | `Input` (a Zod object)                                                                              | required             | Validates every payload.                                                                                                                                       |
| `output`           | `Output` (any Zod schema)                                                                           | required             | Validates every result of `execute`.                                                                                                                           |
| `execute`          | `(payload: z.output<Input>, call: Call, deps: Deps) => z.input<Output> \| Promise<z.input<Output>>` | required             | The handler (`ToolExecute`).                                                                                                                                   |
| `strict`           | `boolean`                                                                                           | `true`               | Copied into `definition.strict`.                                                                                                                               |
| `inputSchema`      | `JsonObject`                                                                                        | derived from `input` | The JSON Schema the model sees for the input, used verbatim as `definition.inputSchema`. It must have `type: 'object'`. `input` still validates every payload. |
| `settings`         | `readonly ConfigField[]`                                                                            | `[]`                 | The configuration fields the tool reads (see [Settings fields](#settings-fields)).                                                                             |
| `resultModalities` | `readonly string[]`                                                                                 | absent               | What the tool's results hand the model besides text, such as `'image'`.                                                                                        |

A tool whose input schema comes from elsewhere, such as an MCP server's tool,
passes the schema as `inputSchema`, a permissive `input` (`z.looseObject({})`)
and `strict: false` ([`mcp/src/host/tools.ts`](../../bundles/features/mcp/src/host/tools.ts));
the [MCP servers feature](../../docs/features/mcp.md#tools) describes those
tools.

### What `defineTool` checks and builds

All of this happens in [`tools.ts`](src/lib/tools.ts), synchronously, when
`defineTool` is called:

1. `input` must be an instance of `z.ZodObject`; otherwise it throws
   `invalid_schema` with the message `Tool input must be a Zod object: <name>`.
2. A given `inputSchema` must have `type === 'object'`; otherwise it throws
   `invalid_schema` with `Tool inputSchema must be an object JSON Schema: <name>`.
3. It builds `definition: ToolDefinition`:
   - `name` and `description` from the options (`description` is `undefined` when
     not given);
   - `inputSchema`: the given `inputSchema`, else `z.toJSONSchema(input, { io: 'output', unrepresentable: 'throw' })`;
   - `outputSchema`: `z.toJSONSchema(output, { io: 'output', unrepresentable: 'throw' })`;
   - `strict`: `options.strict ?? true`.

   A schema Zod cannot represent throws `invalid_schema` with
   `Tool schema cannot be represented as JSON Schema: <name>` (the Zod error as
   `cause`). A conversion that is not a JSON object throws `invalid_schema`; for
   the input, so does one whose `type` is not `'object'`
   (`Tool input must produce an object JSON Schema: <name>`,
   `Tool output must produce a JSON Schema object: <name>`).

4. `settings` is `options.settings ?? []`; `resultModalities`, when given, is
   copied into a frozen array, and the key is absent when it is not given.

### The definition object (`ToolDefinitionObject`)

`defineTool` returns a frozen, unbound tool that can be inspected before it is
registered ([`types/tool.ts`](src/lib/types/tool.ts),
[`tools.ts`](src/lib/tools.ts)):

```ts
interface UnboundTool<Input, Output, Deps = Services> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly settings: readonly ConfigField[];
  readonly resultModalities?: readonly string[];
  bind(deps: Deps): BoundTool<Input, Output>;
}

type ToolDefinitionObject<Input, Output, Deps = Services> = UnboundTool<
  Input,
  Output,
  Deps
> &
  ([Services] extends [Deps] ? Registrable<BoundTool<Input, Output>> : unknown);
```

`bind(deps)` makes no call, never throws and may be repeated; each bound tool
keeps its own `deps`. The definition is registrable with the kernel's
`tools/v1` only when `Deps` accepts the kernel `Services` (the default, or
`unknown`); a tool over any other `Deps` is bound by its owner and registered as
the bound `ContractTool`. A registrable definition carries `bind` under the `bindRegistrant` symbol of `bundle/contracts` too,
which makes it `Registrable`
([`registrable.ts`](../bundle/src/contracts/registrable.ts)). A bundle passes it
to `tools/v1.register`; the runtime calls `[bindRegistrant]` with the
registering bundle's services before the provider stores it, so `tools/v1` holds
the bound tool ([`dispatch.ts`](../bundle/src/runtime/dispatch.ts)). `bind` can
also be called directly, as tests do.

### The bound tool (`BoundTool`)

`bind(services)` returns a frozen `BoundTool`, which satisfies the
`ContractTool` that `tools/v1` stores
([`basic/tools.ts`](../bundle/src/contracts/basic/tools.ts)):

```ts
interface BoundTool<Input, Output> extends ContractTool {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly settings: readonly ConfigField[];
  readonly resultModalities?: readonly string[];
  execute(payload: z.output<Input>, call: Call): Promise<z.output<Output>>;
  check(payload: unknown): ToolPayloadCheck;
  toTool(call: Call): Tool<Input, Output>;
}
```

- `execute(payload, call)` runs the handler as
  `options.execute(payload, call, services)` with the services given to `bind`,
  awaits it, and parses the result with `output.safeParse`. A valid result
  resolves to the parsed data (Zod's output, so transforms and defaults apply).
  An invalid one rejects with `invalid_output`, message
  `Tool handler returned invalid output: <name>` and the Zod issues as `issues`;
  the rejected value itself appears nowhere in the error. A handler that throws
  rejects with its own error. `execute` does not validate `payload`
  ([`tools.ts`](src/lib/tools.ts)).
- `check(payload)` parses `payload` with `input.safeParse`, synchronously, and
  returns `{ success: true, data }` or `{ success: false, issues }`.
- `toTool(call)` returns the agent-loop `Tool` for one prompt call: the same
  name, description, schemas, definition and `check`, and an `execute(payload)`
  that calls `execute(payload, call)`.

`Call` is the prompt call of `bundle/contracts`: `caller`, `scope`, `signal` and
`trace` ([`call.ts`](../bundle/src/contracts/call.ts)). The handler reaches
anything beyond its payload, such as the sandbox or the host, through the
`services` of its bundle.

### `isBoundTool`

```ts
isBoundTool(value: unknown): value is BoundTool
```

True for a non-null object that is not `Registrable` and has a string `name`, an
`execute` function, a `toTool` function, an object `definition` and an array
`settings` ([`tools.ts`](src/lib/tools.ts)). It recognizes what `tools/v1.list`
returns: a tool bound in the same process, and the `RemoteTool` handle of a tool
bound in another process, whose `check` and `execute` run in that process and
return promises ([`envelope/values.ts`](../bundle/src/runtime/envelope/values.ts)).
A `RemoteTool`'s `input` is a placeholder `z.looseObject({})` and its `output`
is `z.unknown()`, so a caller validates a payload with `check`, never with
`tool.input`. An unbound `ToolDefinitionObject` is not a bound tool. The
default runtime fails a run on a listed tool `isBoundTool` rejects, with
`Tool "<name>" was not defined with defineTool.`
([`executor.ts`](../../bundles/runtime/default/src/host/executor.ts),
[default agent feature](../../docs/features/default-agent.md#tools)).

### Settings fields

A tool declares the configuration it reads as `ConfigField`s
([`types/tool.ts`](src/lib/types/tool.ts)):

```ts
type ConfigFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

interface ConfigField {
  readonly key: string;
  readonly label: string;
  readonly kind: ConfigFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  readonly default?: string; // used when the configuration leaves the field absent
  readonly options?: readonly string[]; // the values of an `enum` field only
  readonly advanced?: boolean; // a field an operator rarely needs
}

type ToolConfig = Readonly<Record<string, string>>; // one tool's values, by field key
```

A `secret` value names a stored credential, not a raw secret. The package only
carries the fields on the definition and the bound tool; it reads no values and
passes none to the handler. `tools/v1.catalog`
([`core`](../../bundles/foundation/core/README.md)) and `GET /tools`
([`transport`](../../bundles/foundation/transport/README.md)) list them, and
the Tools section of the settings window draws them from the descriptor alone
([settings feature](../../docs/features/settings.md#tools)).

Two bundles check stored values against the fields; neither passes its result
to a tool:

- [`host-config`](../../bundles/foundation/host-config/README.md) checks every
  registered tool before it stores a configuration, and refuses the
  configuration when a check fails
  ([`service.ts`](../../bundles/foundation/host-config/src/host/config/service.ts),
  [`tool-config.ts`](../../bundles/foundation/host-config/src/host/config/tool-config.ts)).
- [`runtime/default`](../../bundles/runtime/default/README.md) checks the
  prompt's tools at the start of every prompt and refuses the prompt when a
  check fails
  ([`executor.ts`](../../bundles/runtime/default/src/host/executor.ts),
  [`tool-config.ts`](../../bundles/runtime/default/src/host/tool-config.ts)).

Both apply the same rule to each declared field: the value is the stored value
or, when none is stored, the field's `default`; a value that is absent, empty or
whitespace only counts as missing. A missing value is left out, or throws
`Tool <name> requires a <key> value.` when the field is `required`. A stored
empty value therefore does not fall back to the `default`. Stored keys that no
field names are dropped.

### Result modalities

`resultModalities` travels with the definition object, the bound tool and,
across processes, the `RemoteTool` handle. The package does not act on it. The
default executor leaves a tool out of a run whose model's catalog lists input
modalities that miss any of the tool's result modalities, and offers it to a
model the catalog says nothing about
([`runtime/default`](../../bundles/runtime/default/README.md),
[`executor.ts`](../../bundles/runtime/default/src/host/executor.ts)). The
`view-image` tool of [`files`](../../bundles/features/files/README.md) declares
`['image']`; the [attachments feature](../../docs/features/attachments.md#tools-that-return-images)
describes the flow.

## Tool storage

```ts
createToolStorage(tools: readonly Tool[]): ToolStorage

interface Tool<Input = ToolInput, Output = ToolOutput> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly execute: (payload: z.output<Input>) => Promise<z.output<Output>>; // ToolHandler
  readonly check?: (payload: unknown) => ToolPayloadCheck | Promise<ToolPayloadCheck>;
}

interface ToolStorage {
  definitions(): readonly ToolDefinition[];
  calls(turn: ToolTurn): readonly ToolCall[];
  validate(call: ToolCall | ToolCallRequest): ToolCall | Promise<ToolCall>;
  get(name: string): Tool | undefined;
  execute(call: ToolCall | ToolCallRequest): Promise<unknown>;
}
```

A storage is the tool set of one agent loop; it holds no state besides the
tools it was given ([`tools.ts`](src/lib/tools.ts)). Creating it throws
`duplicate_tool` (`Tool names must be unique: <name>`) for the first name that
appears twice.

| Method           | Behavior                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `definitions()`  | Each tool's `definition`, in the order of `tools`.                                                                                                                                    |
| `calls(turn)`    | Parses every `ToolCallRequest` of `turn.toolCalls` (none when absent) into a `ToolCall`, in order; the first unparsable one throws `invalid_json`. It checks no tool name or payload. |
| `validate(call)` | Parses the call when it is a request, finds the tool (`unknown_tool` otherwise), validates the payload, and returns the `ToolCall` with the model's payload as sent.                  |
| `get(name)`      | The tool of that name, or `undefined`.                                                                                                                                                |
| `execute(call)`  | Parses, finds and validates as `validate` does, then runs `tool.execute` with the validated payload and resolves to its result.                                                       |

Details:

- **Parsing.** A value with a `payload` key is a `ToolCall` and is used as is.
  Otherwise it is a `ToolCallRequest`: `arguments` is passed to `JSON.parse`
  and must be a JSON value; a failure throws `invalid_json` with
  `Tool call arguments must be valid JSON: <name>`, the call's `toolName` and
  `callId`, and `diagnostic` set to the first 300 characters of `arguments`
  (followed by `...` when longer). `id`, `name` and `index` are copied.
- **Lookup.** A call whose name no tool has throws `unknown_tool` with
  `Unknown tool requested: <name>`, `toolName` and `callId`.
- **Validation.** A tool without `check` is validated with `input.safeParse`; a
  tool with `check` is validated by it. A failure throws `invalid_payload` with
  `Tool call payload failed validation: <name>`, `toolName`, `callId` and the
  issues. `validate` returns synchronously unless the tool's `check` returns a
  promise, as the `check` of a tool bound in another process does.
- **Execution.** For a tool whose validation is synchronous, `execute`
  validates the payload twice and runs the tool with the data of the second
  validation; a tool whose `check` returns a promise is checked once. The
  tool runs with the validated data, so Zod transforms and defaults apply.
  `execute` always returns a promise: errors of parsing, lookup and validation
  reject it unchanged. Of the errors the tool's `execute` throws, one that is
  `instanceof ToolErrorObject` with code `invalid_output` rejects unchanged;
  any other becomes `handler_failed` with `Tool handler failed: <name>`,
  `toolName`, `callId` and the original error as `cause`. For a tool bound in
  another process the error arrives decoded (see
  [Across processes](#across-processes)); where the class is not rebuilt, its
  `invalid_output` is not `instanceof ToolErrorObject` and becomes
  `handler_failed`, with the decoded error as `cause`.

### Call shapes

```ts
interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly index?: number;
}
interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly payload: JsonValue;
  readonly index?: number;
}
interface ToolTurn {
  readonly toolCalls?: readonly ToolCallRequest[];
}

interface ToolIssue {
  readonly path: string;
  readonly message: string;
}
type ToolPayloadCheck =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly issues: readonly ToolIssue[] };
```

A `ToolCallRequest` is what a provider turn carries (`arguments` is the raw JSON
text); a `ToolCall` is the parsed form ([`types/tool.ts`](src/lib/types/tool.ts)).
A Zod issue becomes a `ToolIssue` whose `path` is the issue path joined with `.`
(`''` for the root) ([`tools.ts`](src/lib/tools.ts)).

## Errors: `ToolErrorObject`

```ts
class ToolErrorObject extends Error {
  readonly data: ToolError;
  constructor(data: ToolError, options?: ErrorOptions);
}

interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly diagnostic?: string;
  readonly issues?: readonly ToolIssue[];
}
```

Its `message` is `data.message`, its `name` is `'ToolErrorObject'`, and
`options.cause` is passed to `Error`
([`tool-error.ts`](src/lib/classes/tool-error.ts)). Every failure the package
raises is one, and callers branch on `data.code`
([`tools.ts`](src/lib/tools.ts)). `unknown_tool` has the message
`Unknown tool requested: <name>`; the other messages are quoted in the sections
above.

| `code`            | Raised by                                         | Fields besides `message`                    |
| ----------------- | ------------------------------------------------- | ------------------------------------------- |
| `invalid_schema`  | `defineTool`                                      | `toolName` (and `cause` for a Zod failure)  |
| `duplicate_tool`  | `createToolStorage`                               | `toolName`                                  |
| `invalid_json`    | `calls`, `validate`, `execute`                    | `toolName`, `callId`, `diagnostic`, `cause` |
| `unknown_tool`    | `validate`, `execute`                             | `toolName`, `callId`                        |
| `invalid_payload` | `validate`, `execute`                             | `toolName`, `callId`, `issues`              |
| `invalid_output`  | a bound tool's `execute`, hence storage `execute` | `toolName`, `issues`                        |
| `handler_failed`  | storage `execute`                                 | `toolName`, `callId`, `cause`               |

### Across processes

An error thrown in one bundle process and received in another is encoded with
its own properties and its constructor name, and decoded with the prototype of
the class registered under that name, else the standard error class of that
name, else `Error.prototype`
([`envelope/errors.ts`](../bundle/src/runtime/envelope/errors.ts)). Only the
kernel process registers `ToolErrorObject`: `doric-host` passes it to
`startKernel` as `errorClasses`
([`boot.ts`](../../app/backend/doric-host/src/lib/bundles/boot.ts),
[`kernel.ts`](../bundle/src/process/kernel.ts)). A generation process starts
with a registry that knows only `ContractError`
([`runner-main.ts`](../bundle/src/process/runner-main.ts)), so there a
`ToolErrorObject` from another process has `Error.prototype`, the `name`
`'ToolErrorObject'`, its `message` and its own `data`, and fails
`instanceof ToolErrorObject`. A caller that may receive a tool error from
another process reads `name` and `data.code` rather than relying on
`instanceof`.

## Schemas

The package exports four Zod schemas for consumers that validate tool data as
plain JSON:

- `ToolDefinitionSchema`: `{ name: string, description?: string, inputSchema: JsonObject, outputSchema: JsonObject, strict?: boolean }`
  ([`definition.ts`](src/lib/schemas/definition.ts)). `ToolDefinition` is its
  output type with every field read-only, and is the shape of every tool's
  `definition` and of what `definitions()` returns
  ([`types/tool.ts`](src/lib/types/tool.ts)). Providers send the fields they
  support and use `inputSchema` as the function parameters
  ([`llms`](../llms/README.md)).
- `ToolMetadataSchema`: `{ name: string, description: string }`, with both
  fields required so it fits strict structured outputs
  ([`metadata.ts`](src/lib/schemas/metadata.ts)); `ToolMetadata` is its
  read-only output type. It describes a tool without its schemas or handler.
- `JsonValueSchema`: a string, a finite number, a boolean, `null`, an array of
  JSON values, or a record of string keys to JSON values (recursive);
  `JsonObjectSchema`: a record of string keys to JSON values
  ([`json.ts`](src/lib/schemas/json.ts)).

## JSON types and helpers

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonArray = readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonValue = JsonPrimitive | JsonArray | JsonObject;
```

([`types/json.ts`](src/lib/types/json.ts)). The helpers
([`utils/json.ts`](src/lib/utils/json.ts)):

| Function                            | Returns                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `isRecord(value: unknown)`          | Whether `value` is a non-null object that is not an array (`value is Record<string, unknown>`).                                                                                                                                            |
| `isJsonValue(value: unknown)`       | Whether `value` is `null`, a string, a boolean, a finite number, an array of JSON values, or a record (any non-null, non-array object, whatever its prototype, so a `Date` or a `Map` passes) whose own enumerable values are JSON values. |
| `asJsonObject(value: unknown)`      | `value` as a `JsonObject` when it is a record and a JSON value, else `undefined`. It does not copy.                                                                                                                                        |
| `excerpt(value: string, max = 300)` | `value` when its length is at most `max`, else its first `max` characters followed by `...`.                                                                                                                                               |

## Side effects and limits

The package starts no process, opens no file or socket and sets no timer. It
keeps no state outside the objects it returns. Everything is synchronous except
a tool's `execute`, storage `execute` and a `check` that returns a promise.
Definition objects and bound tools are frozen, shallowly: the `definition`
object they share, a given `inputSchema` and `settings` (the array given) are
neither frozen nor copied. `toTool` returns a new, unfrozen `Tool` on every
call.

## Build and test

The Nx project is `tool` ([`project.json`](project.json)):

```console
npx nx build tool      # tsc with tsconfig.lib.json into dist/
npx nx typecheck tool
npx nx test tool       # tsc with tsconfig.spec.json into dist-tests/, then node --test
```

`build` and `typecheck` are inferred by `@nx/js/typescript`, which also infers
`build-deps` and `watch-deps` ([`nx.json`](../../nx.json)); `test` compiles [`tests/`](tests) and runs it with
`node --test` ([`tools.test.ts`](tests/tools.test.ts),
[`async-check.test.ts`](tests/async-check.test.ts)).
