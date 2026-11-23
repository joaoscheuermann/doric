// The tools a routed run offers (phase 3, slice S51d): `tools/v1`'s tools as
// in-process `BoundTool`s whose `check` and `execute` are router calls.

import { fromJson, type JsonValue, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type {
  ContractTool,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  type BoundTool,
  type ConfigField,
  type Tool,
  type ToolDefinition,
  ToolDefinitionSchema,
  type ToolError,
  ToolErrorObject,
  type ToolPayloadCheck,
} from 'tool';
import { z } from 'zod';

/** A tool's configuration field, as `tools/v1` carries it (a `Struct`). */
const configFieldSchema: z.ZodType<ConfigField> = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'url', 'number', 'enum', 'secret']),
  required: z.boolean(),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  default: z.string().optional(),
  options: z.array(z.string()).optional(),
  advanced: z.boolean().optional(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `details.toolError` when it is a tool error's data (string `code` and `message`). */
const toolErrorData = (details: unknown): ToolError | undefined => {
  const data = isRecord(details) ? details.toolError : undefined;

  return isRecord(data) &&
    typeof data.code === 'string' &&
    typeof data.message === 'string'
    ? (data as unknown as ToolError)
    : undefined;
};

/** `value` as a protobuf `Value`, through `JSON.stringify` (what the wire carries). */
const wireValue = (value: unknown) =>
  fromJson(
    ValueSchema,
    JSON.parse(JSON.stringify(value) ?? 'null') as JsonValue,
  );

/** Awaits a router call, rejecting with its Doric error. */
export const called = async <T>(request: Promise<T>): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw error instanceof ConnectError ? fromConnectError(error) : error;
  }
};

/** A failed `Execute`, as `called` rejects, as the run reads it (see {@link routedTools}). */
const executeFailure = (failure: unknown): unknown => {
  if (!isContractError(failure)) return failure;
  if (failure.code === 'tool_error') {
    const data = toolErrorData(failure.details);
    return data === undefined ? failure : new ToolErrorObject(data);
  }
  if (failure.code === 'internal') return new Error(failure.message);

  return failure;
};

/** `text`, a JSON Schema text of tool `name`, parsed; `invalid_output` when it is not JSON. */
const schemaOf = (name: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContractError(
      'invalid_output',
      `tools/v1 answered a schema of tool "${name}" that is not JSON.`,
    );
  }
};

/** `tool`'s definition, from its JSON Schema texts. */
const definitionOf = (tool: ContractTool): ToolDefinition => {
  const definition = tool.definition;
  const parsed = ToolDefinitionSchema.safeParse({
    name: definition?.name ?? tool.name,
    ...(definition?.description === undefined
      ? {}
      : { description: definition.description }),
    inputSchema: schemaOf(tool.name, definition?.inputSchema ?? '{}'),
    outputSchema: schemaOf(tool.name, definition?.outputSchema ?? '{}'),
    ...(definition?.strict === undefined ? {} : { strict: definition.strict }),
  });

  if (!parsed.success) {
    throw new ContractError(
      'invalid_output',
      `tools/v1 answered an invalid definition of tool "${tool.name}".`,
    );
  }

  return parsed.data;
};

/** `tool`'s settings, each `Struct` as JSON. */
const settingsOf = (tool: ContractTool): readonly ConfigField[] =>
  tool.settings.map((field) => {
    const parsed = configFieldSchema.safeParse(field);
    if (!parsed.success) {
      throw new ContractError(
        'invalid_output',
        `tools/v1 answered an invalid setting of tool "${tool.name}".`,
      );
    }
    return parsed.data;
  });

const input = z.looseObject({});
const output = z.unknown();

/** One listed tool as a `BoundTool` over `tools`. */
const boundTool = (
  tools: Client<typeof ToolsService>,
  tool: ContractTool,
): BoundTool => {
  const { name, description } = tool;
  const definition = definitionOf(tool);
  const settings = settingsOf(tool);

  const check = async (
    payload: unknown,
    signal: AbortSignal,
  ): Promise<ToolPayloadCheck> => {
    const answer = await called(
      tools.check({ name, payload: wireValue(payload) }, { signal }),
    );
    return answer.success
      ? {
          success: true,
          data:
            answer.data === undefined
              ? undefined
              : toJson(ValueSchema, answer.data),
        }
      : {
          success: false,
          issues: answer.issues.map(({ path, message }) => ({
            path,
            message,
          })),
        };
  };
  const execute = async (
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> => {
    try {
      const { result } = await called(
        tools.execute({ name, payload: wireValue(payload) }, { signal }),
      );
      return result === undefined ? undefined : toJson(ValueSchema, result);
    } catch (error) {
      throw executeFailure(error);
    }
  };
  const toTool = (call: Call): Tool => {
    /** Successful `Check` answers not yet taken, by `JSON.stringify(payload)`: a multiset, each taken once. */
    const checked = new Map<string, ToolPayloadCheck[]>();
    return {
      name,
      ...(description === undefined ? {} : { description }),
      input,
      output,
      definition,
      execute: (payload) => execute(payload, call.signal),
      check: async (payload) => {
        const key = JSON.stringify(payload) as string | undefined;
        if (key !== undefined) {
          const stored = checked.get(key);
          const taken = stored?.shift();
          if (stored?.length === 0) checked.delete(key);
          if (taken !== undefined) return taken;
        }
        const answer = await check(payload, call.signal);
        if (answer.success && key !== undefined)
          checked.set(key, [...(checked.get(key) ?? []), answer]);
        return answer;
      },
    };
  };

  return {
    name,
    ...(description === undefined ? {} : { description }),
    input,
    output,
    definition,
    settings,
    resultModalities: [...tool.resultModalities],
    execute: (payload, call) => execute(payload, call.signal),
    // `BoundTool.check` answers at once; the registrant's own check runs
    // through `toTool(call).check`, which the agent loop calls.
    check: (payload) => {
      const parsed = input.safeParse(payload);
      return parsed.success
        ? { success: true, data: parsed.data }
        : {
            success: false,
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              message: issue.message,
            })),
          };
    },
    toTool,
  };
};

/**
 * `tools/v1.List{}`'s tools as `BoundTool`s (so `isBoundTool` holds), in `List` order. Each has `name`,
 * `description`, `definition` (`inputSchema`/`outputSchema` parsed from their JSON text, `strict`), `settings`
 * (each `Struct` as JSON), `resultModalities`; `input` is `z.looseObject({})` and `output` `z.unknown()`
 * (placeholders: the registrant's schemas validate). `toTool(call)` answers a `Tool` whose:
 * - `check(payload)` is `tools/v1.Check{name, payload}` made with `{signal: call.signal}` → `{success: true, data}`
 *   or `{success: false, issues}`; a failed call rejects (the agent then treats the turn as invalid, as the stage-2
 *   remote tool did). It goes through a check cache of that `Tool` (one per `toTool` call, so per run and per tool
 *   name; dropped with the `Tool`):
 *   - key: `JSON.stringify(payload)` — the text `Check` sends (`wireValue`); `undefined` (not serializable) is never
 *     cached;
 *   - an answer `{success: true, data}` is stored under its key; each stored answer is taken (and removed) by the
 *     next `check` of the same key, which answers it without a call. Entries are a multiset: two calls of the same
 *     payload validated before either executes store two answers and take one each;
 *   - an answer `{success: false, issues}`, and a rejected `Check` (transport failure or `ContractError`), are never
 *     stored: the next check of that payload calls `Check` again;
 *   - so the tool storage's two checks of one call (`validate`, then `execute`) make one `Check`. A call validated
 *     but never executed leaves its answer for the next check of the same payload in the same run, which takes it.
 * - `execute(payload)` is `tools/v1.Execute{name, payload}` made with `{signal: call.signal}`, its `result` as JSON
 *   (`undefined` without one). A failure
 *   rejects with: `new ToolErrorObject(details.toolError)` for `tool_error` with valid details (an object with
 *   string `code` and `message`); a plain `Error(message)` for `internal`; any other `ContractError` unchanged
 *   (`generation_lost`, `unavailable`, `not_found`, `limit_exceeded`, malformed `tool_error`).
 * `BoundTool.execute(payload, call)` makes `Execute` with `{signal: call.signal}` too; `BoundTool.check` is local (no
 * call, no cache). Rejects with `List`'s failure, or
 * `invalid_output` when a schema text is not JSON.
 */
export const routedTools = async (
  tools: Client<typeof ToolsService>,
): Promise<readonly BoundTool[]> => {
  const listed = await called(tools.list({}));

  return listed.tools.flatMap(({ tool }) =>
    tool === undefined ? [] : [boundTool(tools, tool)],
  );
};
