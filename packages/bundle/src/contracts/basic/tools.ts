import { z } from 'zod';

import type { Call } from '../call.js';
import type { Disposable } from '../context.js';
import { ref } from '../define.js';
import type { Registrable } from '../registrable.js';
import type { JsonObject } from '../types.js';
import { disposableSchema, type MethodSpecs, noInput } from './common.js';

/** The serializable definition a model sees for one tool. */
export interface ContractToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema: JsonObject;
  readonly strict?: boolean;
}

/** A tool as tools/v1 stores it: already bound to its registering bundle's services. */
export interface ContractTool {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  readonly definition: ContractToolDefinition;
  /** Configuration field metadata (the `tool` package's ConfigField); opaque here. */
  readonly settings: readonly object[];
  execute(payload: unknown, call: Call): Promise<unknown>;
}

export interface RegisteredTool {
  readonly bundleId: string;
  readonly alwaysAvailable: boolean;
  readonly tool: ContractTool;
}

export interface ToolRegistrationOptions {
  readonly alwaysAvailable: boolean;
}

export interface Tools {
  /** Local. Throws ContractError('duplicate_tool') when the name is taken. */
  register(
    tool: Registrable<ContractTool>,
    options: ToolRegistrationOptions,
  ): Disposable;
  /** Local. Registration order: bundle activation order, then call order. */
  list(): readonly RegisteredTool[];
}

export const ToolsV1 = ref<Tools>('tools/v1');

export const isContractTool = (value: unknown): value is ContractTool => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const tool = value as Partial<ContractTool>;

  return (
    typeof tool.name === 'string' &&
    tool.name.trim().length > 0 &&
    typeof tool.execute === 'function' &&
    typeof tool.definition === 'object' &&
    tool.definition !== null &&
    Array.isArray(tool.settings)
  );
};

export const toolsMethods = {
  register: {
    input: z.tuple([
      z.custom<ContractTool>(isContractTool, {
        message: 'Expected a tool bound by its registrant.',
      }),
      z.object({ alwaysAvailable: z.boolean() }).strict(),
    ]),
    output: disposableSchema,
  },
  list: {
    input: noInput,
    output: z.custom<readonly RegisteredTool[]>((value) =>
      Array.isArray(value),
    ),
  },
} as const satisfies MethodSpecs;
