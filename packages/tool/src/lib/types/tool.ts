import type { z } from 'zod';

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

export type ToolCallRequest = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly index?: number;
};

export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly payload: JsonValue;
  readonly index?: number;
};

export type ToolTurn = {
  readonly toolCalls?: readonly ToolCallRequest[];
};

export type ToolHandler<Input extends ToolInput, Output extends ToolOutput> = (
  payload: z.output<Input>,
) => Promise<z.output<Output>>;

export type Tool<
  Input extends ToolInput = ToolInput,
  Output extends ToolOutput = ToolOutput,
> = {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
  readonly execute: ToolHandler<Input, Output>;
};

export type ToolFactoryHandler<
  Input extends ToolInput,
  Output extends ToolOutput,
> = (
  sandbox: Sandbox,
  payload: z.output<Input>,
) => z.input<Output> | Promise<z.input<Output>>;

export type DefineToolOptions<
  Input extends ToolInput,
  Output extends ToolOutput,
> = {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly execute: ToolFactoryHandler<Input, Output>;
  readonly strict?: boolean;
};

export type ToolFactory<
  Input extends ToolInput = ToolInput,
  Output extends ToolOutput = ToolOutput,
> = {
  (sandbox: Sandbox): Tool<Input, Output>;
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly output: Output;
  readonly definition: ToolDefinition;
};

export type ToolStorage = {
  definitions(): readonly ToolDefinition[];

  calls(turn: ToolTurn): readonly ToolCall[];

  validate(call: ToolCall | ToolCallRequest): ToolCall;

  get(name: string): Tool | undefined;

  execute(call: ToolCall | ToolCallRequest): Promise<unknown>;
};

export type ToolErrorCode =
  | 'duplicate_tool'
  | 'handler_failed'
  | 'invalid_json'
  | 'invalid_output'
  | 'invalid_payload'
  | 'invalid_schema'
  | 'unknown_tool';

export type ToolIssue = {
  readonly path: string;
  readonly message: string;
};

export type ToolError = {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly toolName?: string;
  readonly callId?: string;
  readonly diagnostic?: string;
  readonly issues?: readonly ToolIssue[];
};
