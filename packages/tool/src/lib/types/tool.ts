import type { z } from 'zod';

import type { Host } from 'host';
import type { Sandbox } from 'sandbox';

import type { ToolDefinitionSchema } from '../schemas/definition.js';
import type { ToolMetadataSchema } from '../schemas/metadata.js';
import type { JsonValue } from './json.js';

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
}

export type ToolFactoryHandler<
  Input extends ToolInput,
  Output extends ToolOutput,
> = (
  sandbox: Sandbox,
  host: Host,
  payload: z.output<Input>,
  config: ToolConfig,
) => z.input<Output> | Promise<z.input<Output>>;

export interface DefineToolOptions<
  Input extends ToolInput,
  Output extends ToolOutput,
> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly execute: ToolFactoryHandler<Input, Output>;
  readonly strict?: boolean;
  /**
   * The configuration fields this tool reads. A host aggregates them into the
   * settings surface and validates the persisted values against them; the values
   * arrive at `execute` as its fourth argument.
   */
  readonly settings?: readonly ConfigField[];
}

export interface ToolFactory<
  Input extends ToolInput = ToolInput,
  Output extends ToolOutput = ToolOutput,
> {
  (sandbox: Sandbox, host: Host, config?: ToolConfig): Tool<Input, Output>;
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly settings: readonly ConfigField[];
}

export interface ToolStorage {
  definitions(): readonly ToolDefinition[];

  calls(turn: ToolTurn): readonly ToolCall[];

  validate(call: ToolCall | ToolCallRequest): ToolCall;

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
