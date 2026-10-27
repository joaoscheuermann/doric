import type {
  Call,
  ContractTool,
  Registrable,
  Services,
} from 'bundle/contracts';
import type { z } from 'zod';

import type { ToolDefinitionSchema } from '../schemas/definition.js';
import type { ToolMetadataSchema } from '../schemas/metadata.js';
import type { JsonObject, JsonValue } from './json.js';

export type ToolInput = z.ZodObject;

export type ToolOutput = z.ZodType;

type ToolDefinitionValue = z.output<typeof ToolDefinitionSchema>;

type ToolMetadataValue = z.output<typeof ToolMetadataSchema>;

export type ToolDefinition = {
  readonly [Key in keyof ToolDefinitionValue]: ToolDefinitionValue[Key];
};

export type ToolMetadata = {
  readonly [Key in keyof ToolMetadataValue]: ToolMetadataValue[Key];
};

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly index?: number;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly payload: JsonValue;
  readonly index?: number;
}

export interface ToolTurn {
  readonly toolCalls?: readonly ToolCallRequest[];
}

/** One configuration value a tool reads: a literal string, keyed by its field. */
export type ToolConfig = Readonly<Record<string, string>>;

/** The value kinds a tool configuration field can carry. */
export type ConfigFieldKind = 'text' | 'url' | 'number' | 'enum' | 'secret';

/**
 * One configuration field a tool declares. It mirrors a provider kind's fields,
 * so a settings surface draws a tool it has never seen from the descriptor alone:
 * the field fixes how it is drawn (`kind`), what it is called, and whether it must
 * be present. A `secret` value names a stored credential rather than a raw secret.
 */
export interface ConfigField {
  readonly key: string;
  readonly label: string;
  readonly kind: ConfigFieldKind;
  readonly required: boolean;
  readonly description?: string;
  readonly placeholder?: string;
  /** The value a field falls back to when the configuration leaves it absent. */
  readonly default?: string;
  /** The values an `enum` field offers; present only for `kind: 'enum'`. */
  readonly options?: readonly string[];
  /**
   * Whether the field is one an operator rarely needs, so a settings surface can
   * keep it out of the way and show the necessary fields alone.
   */
  readonly advanced?: boolean;
}

export type ToolHandler<Input extends ToolInput, Output extends ToolOutput> = (
  payload: z.output<Input>,
) => Promise<z.output<Output>>;

/**
 * The result of validating one payload against a tool's input schema, in the
 * process that owns the tool. `data` is the parsed payload the tool executes.
 */
export type ToolPayloadCheck =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly issues: readonly ToolIssue[] };

export interface Tool<
  Input extends ToolInput = ToolInput,
  Output extends ToolOutput = ToolOutput,
> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly execute: ToolHandler<Input, Output>;
  /**
   * Exact payload validation. When it is absent, `input` validates the payload.
   * A tool that runs in another process checks asynchronously.
   */
  readonly check?: (
    payload: unknown,
  ) => ToolPayloadCheck | Promise<ToolPayloadCheck>;
}

/**
 * What a tool runs: the validated payload, the prompt `Call` it was invoked
 * through, and the services of the bundle that registered it.
 */
export type ToolExecute<Input extends ToolInput, Output extends ToolOutput> = (
  payload: z.output<Input>,
  call: Call,
  services: Services,
) => z.input<Output> | Promise<z.input<Output>>;

export interface DefineToolOptions<
  Input extends ToolInput,
  Output extends ToolOutput,
> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly execute: ToolExecute<Input, Output>;
  readonly strict?: boolean;
  /**
   * The JSON Schema the model sees for the input, used verbatim as
   * `definition.inputSchema` instead of the one derived from `input`. It must
   * be an object schema (`type: 'object'`), or `defineTool` throws a
   * ToolErrorObject with code `invalid_schema`. `input` still validates every
   * payload: a tool whose schema comes from elsewhere (an MCP server) passes a
   * permissive `input` (`z.looseObject({})`) and `strict: false`.
   */
  readonly inputSchema?: JsonObject;
  /**
   * The configuration fields this tool reads. A host aggregates them into the
   * settings surface and validates the persisted values against them; the
   * values themselves are read through `settings/v1` once it exists.
   */
  readonly settings?: readonly ConfigField[];
}

/**
 * A tool bound to the services of the bundle that registered it. It is what
 * `tools/v1` stores, and `toTool(call)` turns it into the agent-loop `Tool`
 * for one prompt.
 */
export interface BoundTool<
  Input extends ToolInput = ToolInput,
  Output extends ToolOutput = ToolOutput,
> extends ContractTool {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly settings: readonly ConfigField[];
  execute(payload: z.output<Input>, call: Call): Promise<z.output<Output>>;
  /** Validates a payload against `input` without executing the tool. */
  check(payload: unknown): ToolPayloadCheck;
  /** The agent-loop tool whose executions run under `call`. */
  toTool(call: Call): Tool<Input, Output>;
}

/**
 * An inspectable, unbound tool: what a bundle registers with `tools/v1`, which
 * binds it to the registering bundle's services.
 */
export interface ToolDefinitionObject<
  Input extends ToolInput = ToolInput,
  Output extends ToolOutput = ToolOutput,
> extends Registrable<BoundTool<Input, Output>> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly settings: readonly ConfigField[];
  bind(services: Services): BoundTool<Input, Output>;
}

export interface ToolStorage {
  definitions(): readonly ToolDefinition[];

  calls(turn: ToolTurn): readonly ToolCall[];

  /**
   * Parses and validates one call without executing it. The result is
   * asynchronous only when the tool's `check` is.
   */
  validate(call: ToolCall | ToolCallRequest): ToolCall | Promise<ToolCall>;

  get(name: string): Tool | undefined;

  execute(call: ToolCall | ToolCallRequest): Promise<unknown>;
}

export type ToolErrorCode =
  | 'duplicate_tool'
  | 'handler_failed'
  | 'invalid_json'
  | 'invalid_output'
  | 'invalid_payload'
  | 'invalid_schema'
  | 'unknown_tool';

export interface ToolIssue {
  readonly path: string;
  readonly message: string;
}

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly diagnostic?: string;
  readonly issues?: readonly ToolIssue[];
}
