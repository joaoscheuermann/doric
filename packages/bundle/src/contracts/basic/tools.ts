import { z } from 'zod';

import type { Call, CallArg } from '../call.js';
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

/** One validation issue of a tool payload, as the model repair flow shows it. */
export interface ToolIssueView {
  readonly path: string;
  readonly message: string;
}

/** Result of validating a tool payload with the tool's own schema. */
export type ToolPayloadCheck =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly issues: readonly ToolIssueView[] };

/** A tool as tools/v1 stores it: already bound to its registering bundle's services. */
export interface ContractTool {
  readonly name: string;
  readonly description?: string;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  readonly definition: ContractToolDefinition;
  /** Configuration field metadata (the `tool` package's ConfigField); opaque here. */
  readonly settings: readonly object[];
  /** Exact payload validation in the tool's own process; asynchronous only for remote tools. */
  check?(payload: unknown): ToolPayloadCheck | Promise<ToolPayloadCheck>;
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
  /**
   * Registration order: bundle activation order, then call order. Tools cross
   * as tool handles and are the registered tool again in their own process;
   * called from another process the result arrives as a promise of the same
   * list, so a remote caller awaits it. The call picks the generation whose
   * tools are listed (D4-11).
   */
  list(call?: CallArg): readonly RegisteredTool[];
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
