import { z } from 'zod';

import type { Sandbox } from 'sandbox';

import { ToolErrorObject } from './classes/tool-error.js';
import type { JsonObject } from './types/json.js';
import type {
  DefineToolOptions,
  Tool,
  ToolCall,
  ToolCallRequest,
  ToolDefinition,
  ToolFactory,
  ToolInput,
  ToolIssue,
  ToolOutput,
  ToolStorage,
  ToolTurn,
} from './types/tool.js';
import { asJsonObject, excerpt, isJsonValue } from './utils/json.js';

/** Defines an inspectable tool factory that binds execution to a sandbox. */
export const defineTool = <Input extends ToolInput, Output extends ToolOutput>(
  options: DefineToolOptions<Input, Output>,
): ToolFactory<Input, Output> => {
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

  const factory = ((sandbox: Sandbox): Tool<Input, Output> => ({
    name: options.name,
    description: options.description,
    input: options.input,
    output: options.output,
    definition,
    execute: async (payload) => {
      const result = await options.execute(sandbox, payload);
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
    },
  })) as ToolFactory<Input, Output>;

  Object.defineProperties(factory, {
    name: { value: options.name },
    description: { value: options.description },
    input: { value: options.input },
    output: { value: options.output },
    definition: { value: definition },
  });

  return factory;
};

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

  const validate = (call: ToolCall | ToolCallRequest): ToolCall => {
    const parsed = normalizeCall(call);
    const tool = byName.get(parsed.name);

    if (tool === undefined) {
      throw new ToolErrorObject({
        code: 'unknown_tool',
        toolName: parsed.name,
        callId: parsed.id,
        message: `Unknown tool requested: ${parsed.name}`,
      });
    }

    validatePayload(tool, parsed);

    return parsed;
  };

  return {
    definitions: () => tools.map((tool) => tool.definition),
    calls: (turn: ToolTurn) => (turn.toolCalls ?? []).map(parseCall),
    validate,
    get: (name: string) => byName.get(name),
    execute: async (call: ToolCall | ToolCallRequest): Promise<unknown> => {
      const parsed = validate(call);
      const tool = byName.get(parsed.name)!;
      const payload = validatePayload(tool, parsed);

      try {
        return await tool.execute(payload);
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

const issueFromZod = (issue: z.core.$ZodIssue): ToolIssue => ({
  path: issue.path.map(String).join('.'),
  message: issue.message,
});
