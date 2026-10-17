import {
  bindRegistrant,
  type Call,
  isRegistrable,
  type Services,
} from 'bundle/contracts';
import { z } from 'zod';

import { ToolErrorObject } from './classes/tool-error.js';
import type { JsonObject } from './types/json.js';
import type {
  BoundTool,
  DefineToolOptions,
  Tool,
  ToolCall,
  ToolCallRequest,
  ToolDefinition,
  ToolDefinitionObject,
  ToolInput,
  ToolIssue,
  ToolOutput,
  ToolPayloadCheck,
  ToolStorage,
  ToolTurn,
} from './types/tool.js';
import { asJsonObject, excerpt, isJsonValue } from './utils/json.js';

/**
 * Defines an inspectable tool. Registering it with `tools/v1` binds it to the
 * registering bundle's services; `toTool(call)` then gives the agent-loop tool
 * for one prompt call.
 */
export const defineTool = <Input extends ToolInput, Output extends ToolOutput>(
  options: DefineToolOptions<Input, Output>,
): ToolDefinitionObject<Input, Output> => {
  if (!(options.input instanceof z.ZodObject)) {
    throw new ToolErrorObject({
      code: 'invalid_schema',
      toolName: options.name,
      message: `Tool input must be a Zod object: ${options.name}`,
    });
  }

  const definition: ToolDefinition = {
    name: options.name,
    description: options.description,
    inputSchema: jsonSchema(options.name, options.input, true),
    outputSchema: jsonSchema(options.name, options.output, false),
    strict: options.strict ?? true,
  };
  const settings = options.settings ?? [];

  const bind = (services: Services): BoundTool<Input, Output> => {
    const execute = async (
      payload: z.output<Input>,
      call: Call,
    ): Promise<z.output<Output>> => {
      const result = await options.execute(payload, call, services);
      const parsed = options.output.safeParse(result);

      if (parsed.success) {
        return parsed.data;
      }

      throw new ToolErrorObject({
        code: 'invalid_output',
        toolName: options.name,
        message: `Tool handler returned invalid output: ${options.name}`,
        issues: parsed.error.issues.map(issueFromZod),
      });
    };

    const check = (payload: unknown): ToolPayloadCheck => {
      const parsed = options.input.safeParse(payload);

      return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, issues: parsed.error.issues.map(issueFromZod) };
    };

    return Object.freeze({
      name: options.name,
      description: options.description,
      input: options.input,
      output: options.output,
      definition,
      settings,
      execute,
      check,
      toTool: (call: Call): Tool<Input, Output> => ({
        name: options.name,
        description: options.description,
        input: options.input,
        output: options.output,
        definition,
        execute: (payload) => execute(payload, call),
        check,
      }),
    });
  };

  return Object.freeze({
    name: options.name,
    description: options.description,
    input: options.input,
    output: options.output,
    definition,
    settings,
    bind,
    [bindRegistrant]: bind,
  });
};

/** Whether a tool read back from `tools/v1` is one `defineTool` bound. */
export const isBoundTool = (value: unknown): value is BoundTool =>
  typeof value === 'object' &&
  value !== null &&
  !isRegistrable(value) &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { execute?: unknown }).execute === 'function' &&
  typeof (value as { toTool?: unknown }).toTool === 'function' &&
  typeof (value as { definition?: unknown }).definition === 'object' &&
  Array.isArray((value as { settings?: unknown }).settings);

/** Registers tools and provides neutral definitions, call parsing, lookup, and execution. */
export const createToolStorage = (tools: readonly Tool[]): ToolStorage => {
  const entries = tools.map((tool) => [tool.name, tool] as const);
  const names = new Set<string>();

  const duplicate = entries.find(([name]) => {
    if (names.has(name)) {
      return true;
    }

    names.add(name);

    return false;
  });

  if (duplicate !== undefined) {
    throw new ToolErrorObject({
      code: 'duplicate_tool',
      toolName: duplicate[0],
      message: `Tool names must be unique: ${duplicate[0]}`,
    });
  }

  const byName = new Map(entries);

  const requireTool = (call: ToolCall): Tool => {
    const tool = byName.get(call.name);

    if (tool === undefined) {
      throw new ToolErrorObject({
        code: 'unknown_tool',
        toolName: call.name,
        callId: call.id,
        message: `Unknown tool requested: ${call.name}`,
      });
    }

    return tool;
  };

  /**
   * The validated payload of a call. Tools without `check`, or with a
   * synchronous one, stay synchronous; only a `check` that returns a promise
   * makes the result asynchronous.
   */
  const checkPayload = (
    tool: Tool,
    call: ToolCall,
  ): { readonly payload: unknown } | Promise<unknown> => {
    if (tool.check === undefined) {
      return { payload: validatePayload(tool, call) };
    }

    const checked = tool.check(call.payload);

    return checked instanceof Promise
      ? checked.then((result) => payloadFromCheck(call, result))
      : { payload: payloadFromCheck(call, checked) };
  };

  const validate = (
    call: ToolCall | ToolCallRequest,
  ): ToolCall | Promise<ToolCall> => {
    const parsed = normalizeCall(call);
    const checked = checkPayload(requireTool(parsed), parsed);

    return checked instanceof Promise ? checked.then(() => parsed) : parsed;
  };

  /** Synchronous tools validate twice, as before; asynchronous ones once. */
  const executablePayload = async (
    tool: Tool,
    call: ToolCall,
  ): Promise<unknown> => {
    const checked = checkPayload(tool, call);

    if (checked instanceof Promise) {
      return await checked;
    }

    const again = checkPayload(tool, call);

    return again instanceof Promise ? await again : again.payload;
  };

  return {
    definitions: () => tools.map((tool) => tool.definition),
    calls: (turn: ToolTurn) => (turn.toolCalls ?? []).map(parseCall),
    validate,
    get: (name: string) => byName.get(name),
    execute: async (call: ToolCall | ToolCallRequest): Promise<unknown> => {
      const parsed = normalizeCall(call);
      const tool = requireTool(parsed);
      const payload = await executablePayload(tool, parsed);

      try {
        return await tool.execute(payload as z.output<ToolInput>);
      } catch (cause) {
        if (
          cause instanceof ToolErrorObject &&
          cause.data.code === 'invalid_output'
        ) {
          throw cause;
        }

        throw new ToolErrorObject(
          {
            code: 'handler_failed',
            toolName: parsed.name,
            callId: parsed.id,
            message: `Tool handler failed: ${parsed.name}`,
          },
          { cause },
        );
      }
    },
  };
};

const jsonSchema = (
  name: string,
  schema: ToolOutput,
  requireObject: boolean,
): JsonObject => {
  let value: unknown;

  try {
    value = z.toJSONSchema(schema, {
      io: 'output',
      unrepresentable: 'throw',
    });
  } catch (cause) {
    throw new ToolErrorObject(
      {
        code: 'invalid_schema',
        toolName: name,
        message: `Tool schema cannot be represented as JSON Schema: ${name}`,
      },
      { cause },
    );
  }

  const json = asJsonObject(value);

  if (json === undefined || (requireObject && json.type !== 'object')) {
    throw new ToolErrorObject({
      code: 'invalid_schema',
      toolName: name,
      message: requireObject
        ? `Tool input must produce an object JSON Schema: ${name}`
        : `Tool output must produce a JSON Schema object: ${name}`,
    });
  }

  return json;
};

const parseCall = (call: ToolCallRequest): ToolCall => {
  try {
    const payload = JSON.parse(call.arguments) as unknown;

    if (!isJsonValue(payload)) {
      throw new Error('Tool arguments must be JSON values.');
    }

    return {
      id: call.id,
      name: call.name,
      payload,
      index: call.index,
    };
  } catch (cause) {
    throw new ToolErrorObject(
      {
        code: 'invalid_json',
        toolName: call.name,
        callId: call.id,
        message: `Tool call arguments must be valid JSON: ${call.name}`,
        diagnostic: excerpt(call.arguments),
      },
      { cause },
    );
  }
};

const normalizeCall = (call: ToolCall | ToolCallRequest): ToolCall =>
  'payload' in call ? call : parseCall(call);

const validatePayload = <Input extends ToolInput>(
  tool: Tool<Input>,
  call: ToolCall,
): z.output<Input> => {
  const parsed = tool.input.safeParse(call.payload);

  if (parsed.success) {
    return parsed.data;
  }

  throw new ToolErrorObject({
    code: 'invalid_payload',
    toolName: call.name,
    callId: call.id,
    message: `Tool call payload failed validation: ${call.name}`,
    issues: parsed.error.issues.map(issueFromZod),
  });
};

const payloadFromCheck = (
  call: ToolCall,
  result: ToolPayloadCheck,
): unknown => {
  if (result.success) {
    return result.data;
  }

  throw new ToolErrorObject({
    code: 'invalid_payload',
    toolName: call.name,
    callId: call.id,
    message: `Tool call payload failed validation: ${call.name}`,
    issues: result.issues,
  });
};

const issueFromZod = (issue: z.core.$ZodIssue): ToolIssue => ({
  path: issue.path.map(String).join('.'),
  message: issue.message,
});
