// The handler services of tools/v1 and hooks/v1 for a host part (spec
// `docs/designs/grpc-processes.md`, section 4, "Handler services"; phase 3,
// slice S45): a table of local tools or hook handlers, served as
// `ToolHandlerService` / `HookHandlerService`, each entry registered with
// `core` through `context.registrations.track`, so it is registered again
// after `core` restarts (T3.5).

import {
  create,
  type DescMessage,
  type DescService,
  fromJson,
  getOption,
  hasOption,
  isMessage,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import {
  type Any,
  anyPack,
  anyUnpack,
  type Value,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError, type ServiceImpl } from '@connectrpc/connect';

import type {
  ContractTool,
  ToolPayloadCheck,
  ToolRegistrationOptions,
} from '../../contracts/basic/tools.js';
import type { Call } from '../../contracts/call.js';
import { ContractError } from '../../contracts/error.js';
import {
  type Decision,
  DecisionSchema,
  type HookHandlerService,
  type HookHandlerServiceHandleResponseSchema,
  HooksService,
} from '../../contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  HookKind,
  hook as hookOption,
  hooks as hooksOption,
} from '../../contracts/gen/doric/platform/v1/options_pb.js';
import {
  type ToolHandlerService,
  type ToolHandlerServiceCheckResponseSchema,
  ToolsService,
} from '../../contracts/gen/doric/tools/v1/tools_pb.js';
import { callOf } from '../../contracts/metadata.js';
import { fromConnectError } from '../../contracts/status.js';
import type { HostContext, TrackedRegistration } from './context.js';

/**
 * One local registration made through {@link ToolHandlers.register} or
 * {@link HookHandlers.register}: live while the provider holds it, and
 * replayed to each new provider instance until `unregister`.
 */
export interface HandlerRegistration {
  /**
   * The `registrationId` the provider answered last: the first answer, or
   * the answer of the latest replay (`TrackedRegistration.current`).
   */
  readonly registrationId: string;
  /**
   * Ends the registration:
   * - It stops serving the entry at once (a later call for it answers
   *   `not_found`) and stops its replay (`untrack`).
   * - It then calls the contract's `Unregister{registrationId}`
   *   (`tools/v1` or `hooks/v1`), resolving when that call resolves. A
   *   failure of the call rejects with the provider's error (`ContractError`
   *   by `fromConnectError`). The entry stays unserved and untracked.
   * - A second call, or a call on a registration whose key a later `register`
   *   replaced, does nothing and resolves at once. It never ends the
   *   replacement.
   */
  unregister(): Promise<void>;
}

/**
 * The local tools of a host part. One table per process: built at load
 * with no I/O, so `main.ts` lists `[ToolHandlerService,
 * tools.implementation]` statically, and filled from `activate` on.
 */
export interface ToolHandlers {
  /**
   * `ToolHandlerService`, as `tools/v1`'s provider calls it on this
   * instance. A request names a served tool by its key: `name` and
   * `projectId`, the latter absent for an unscoped tool. No other tool
   * answers for a key, so an unscoped request never reaches a scoped tool.
   *
   * `Check{name, projectId?, payload}`:
   * - answers the tool's `check(payload)` when it has one;
   * - otherwise answers `tool.input.safeParse(payload)`, as `{success: true,
   *   data}` or as `{success: false, issues}` with one `{path, message}` per
   *   zod issue, `path` being the issue's path joined by `.`.
   * - `data` crosses as JSON, as `Execute`'s result does.
   *
   * `Execute{name, projectId?, payload}`:
   * - awaits `tool.execute(payload, call)`. `call` is `callOf` of the
   *   handler context, so its caller is the provider (`core`) and its scope,
   *   trace, deadline and signal are those of the `tools/v1.Execute` call it
   *   relays.
   * - The result crosses as JSON: what `JSON.stringify` writes (`toJSON`
   *   applies, and `undefined` members are dropped). A result of `undefined`
   *   answers no `result`.
   *
   * Errors of both methods:
   * - `not_found` when no tool of this table is served under the key;
   * - the tool's `ContractError` unchanged;
   * - any other throw as `internal` with its message (the SDK's encoding);
   * - `invalid_output` when `JSON.stringify` throws on the result or the data
   *   (a bigint, a cycle).
   */
  readonly implementation: ServiceImpl<typeof ToolHandlerService>;
  /**
   * Serves `tool` under its key `(tool.name, options.projectId)` and
   * registers it through `context.registrations.track(ToolsService, …)`.
   * The tracked call is `tools/v1.Register` with:
   * - `tool`: `{name, description?, definition: {name, description?,
   *   inputSchema: JSON.stringify(definition.inputSchema), outputSchema:
   *   JSON.stringify(definition.outputSchema), strict?}, settings,
   *   resultModalities}`;
   * - `options`: `{alwaysAvailable, order?, projectId?}`.
   *
   * Every replay sends the same request.
   *
   * Resolves with the registration once `Register` resolved.
   *
   * Serving:
   * - A new key is served from the call on.
   * - A key already served keeps its previous tool until `Register`
   *   resolves. The new tool and handle then replace the previous ones, and
   *   the previous registration is untracked; `core` keeps one id for the
   *   key.
   *
   * Failure: rejects with the provider's error (`duplicate_tool` for a key
   * that collides with another bundle's, or with another key of this
   * bundle; `invalid_input` for a malformed tool) and tracks nothing. A new
   * key is then no longer served; a replaced key keeps its previous tool
   * and handle.
   *
   * Usable from `activate` until the instance stops. `tool` is used as given:
   * the caller binds it to whatever it needs beforehand.
   */
  register(
    context: Pick<HostContext, 'registrations'>,
    tool: ContractTool,
    options: ToolRegistrationOptions,
  ): Promise<HandlerRegistration>;
}

/** Creates an empty tool table. No I/O; never throws. */
export const createToolHandlers = (): ToolHandlers => {
  const table = createTable<ContractTool>();
  const served = (name: string, projectId: string | undefined) => {
    const tool = table.find(toolKey(name, projectId));

    if (tool === undefined) {
      throw new ContractError(
        'not_found',
        `No tool ${name} is served${projectId === undefined ? '' : ` for Project ${projectId}`}.`,
      );
    }

    return tool;
  };

  return {
    implementation: {
      check: async (request) => {
        const tool = served(request.name, request.projectId);
        const payload = jsonOf(request.payload);
        const checked =
          tool.check === undefined
            ? parsedPayload(tool, payload)
            : await tool.check(payload);

        return checkResponseOf(checked);
      },
      execute: async (request, handlerContext) => {
        const tool = served(request.name, request.projectId);
        const result = asValue(
          await tool.execute(jsonOf(request.payload), callOf(handlerContext)),
        );

        return result === undefined ? {} : { result };
      },
    },
    register: (context, tool, options) => {
      const tracked = {
        tool: {
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          definition: {
            name: tool.definition.name,
            ...(tool.definition.description === undefined
              ? {}
              : { description: tool.definition.description }),
            inputSchema: JSON.stringify(tool.definition.inputSchema),
            outputSchema: JSON.stringify(tool.definition.outputSchema),
            ...(tool.definition.strict === undefined
              ? {}
              : { strict: tool.definition.strict }),
          },
          settings: tool.settings.map((setting) => ({ ...setting })),
          resultModalities: [...(tool.resultModalities ?? [])],
        },
        options: {
          alwaysAvailable: options.alwaysAvailable,
          ...(options.order === undefined ? {} : { order: options.order }),
          ...(options.projectId === undefined
            ? {}
            : { projectId: options.projectId }),
        },
      };

      return table.register(
        context,
        toolKey(tool.name, options.projectId),
        tool,
        ToolsService,
        async (client) => (await client.register(tracked)).registrationId,
        async (client, registrationId) => {
          await client.unregister({ registrationId });
        },
      );
    },
  };
};

/**
 * What a hook handler answers, by the hook's kind (read from the input
 * message's `(doric.platform.v1.hook).kind`):
 * - observe and sequence: nothing (any value is ignored);
 * - transform: a message of the hook's input type, or nothing for "no
 *   change";
 * - decide: a decision, or nothing for "allow".
 */
export type HookAnswer<I extends DescMessage> =
  | MessageShape<I>
  | MessageInitShape<typeof DecisionSchema>
  | void;

/**
 * Handles one run of a hook. `input` is the run's input, unpacked to the
 * hook's message. `call` is `callOf` of the `Handle` call, carrying the
 * `hooks/v1.Run` call's scope, trace, deadline and signal.
 */
export type HookHandle<I extends DescMessage> = (
  input: MessageShape<I>,
  call: Call,
) => HookAnswer<I> | Promise<HookAnswer<I>>;

/** How a hook handler is registered. */
export interface HookHandlerOptions {
  /**
   * The handler's position among the hook's handlers, a positive whole
   * number (`hooks/v1.Register.order`); absent, after the ordered ones.
   */
  readonly order?: number;
}

/**
 * The hook handlers of a host part. One table per process: built at load
 * with no I/O, so `main.ts` lists `[HookHandlerService,
 * hooks.implementation]` statically, and filled from `activate` on.
 */
export interface HookHandlers {
  /**
   * `HookHandlerService.Handle{contract, hook, input}`, as `hooks/v1`'s
   * provider calls it on this instance. It runs the handler served for
   * `(contract, hook)` with `input` unpacked to the registered message, and
   * answers by the hook's kind:
   * - observe and sequence: `{}` once the handler settled;
   * - transform: `{output}`, the handler's message packed as `Any`, or
   *   `input` unchanged when it answered nothing;
   * - decide: `{decision}`, the handler's decision, or `{allow: true}` when
   *   it answered nothing.
   *
   * Fails with:
   * - `not_found` when no handler is served for `(contract, hook)`;
   * - `invalid_input` when `input` is not an `Any` of the registered message;
   * - `invalid_output` when a transform answer is not a message of that type,
   *   or a decide answer is not a decision obeying `allow != has(reason)`;
   * - the handler's `ContractError` unchanged, any other throw as `internal`.
   *
   * For a sequence hook, a failure fails the run, and so the host's start
   * for `onHostStartHook`.
   */
  readonly implementation: ServiceImpl<typeof HookHandlerService>;
  /**
   * Serves `handle` for the hook whose input message is `input`. The
   * contract id is the file's `(doric.platform.v1.hooks).id` and the hook is
   * the message's `(doric.platform.v1.hook).name`.
   *
   * It registers through `context.registrations.track(HooksService, …)`,
   * calling `hooks/v1.Register{contract, hook, order?}`, and replays the same
   * request.
   *
   * Resolves with the registration once `Register` resolved.
   *
   * Serving:
   * - A new `(contract, hook)` is served from the call on.
   * - One already served keeps its previous handler until `Register`
   *   resolves. The new handler and handle then replace the previous ones,
   *   and the previous registration is untracked.
   *
   * Failure: rejects with the provider's error (`invalid_input` for a hook
   * the contract lacks) and tracks nothing. A new key is then no longer
   * served; a replaced key keeps its previous handler.
   *
   * Rejects with a `TypeError`, calling nothing, when `input` has no
   * `(doric.platform.v1.hook)` option with a kind other than unspecified, or
   * its file has no `(doric.platform.v1.hooks)` option.
   *
   * Usable from `activate` until the instance stops.
   */
  register<I extends DescMessage>(
    context: Pick<HostContext, 'registrations'>,
    input: I,
    handle: HookHandle<I>,
    options?: HookHandlerOptions,
  ): Promise<HandlerRegistration>;
}

/** Creates an empty hook handler table. No I/O; never throws. */
export const createHookHandlers = (): HookHandlers => {
  const table = createTable<ServedHook>();

  return {
    implementation: {
      handle: async (request, handlerContext) => {
        const served = table.find(hookKey(request.contract, request.hook));

        if (served === undefined) {
          throw new ContractError(
            'not_found',
            `No handler of ${request.contract} ${request.hook} is served.`,
          );
        }

        if (request.input === undefined) {
          throw new ContractError('invalid_input', 'The hook input is missing.');
        }

        return await served(request.input, callOf(handlerContext));
      },
    },
    register: async (context, input, handle, options = {}) => {
      const { contract, hook, kind } = hookOf(input);
      const run: ServedHook = async (packed, call) => {
        const message = anyUnpack(packed, input);

        if (message === undefined) {
          throw new ContractError(
            'invalid_input',
            `The input of ${contract} ${hook} is not a ${input.typeName}.`,
          );
        }

        const answer = await handle(message, call);

        switch (kind) {
          case HookKind.TRANSFORM:
            if (answer === undefined) {
              return { output: packed };
            }

            if (!isMessage(answer, input)) {
              throw new ContractError(
                'invalid_output',
                `A ${hook} handler must answer a ${input.typeName}.`,
              );
            }

            return { output: anyPack(input, answer) };
          case HookKind.DECIDE:
            return {
              decision:
                answer === undefined
                  ? create(DecisionSchema, { allow: true })
                  : decisionOf(hook, answer),
            };
          default:
            return {};
        }
      };

      return await table.register(
        context,
        hookKey(contract, hook),
        run,
        HooksService,
        async (client) =>
          (
            await client.register({
              contract,
              hook,
              ...(options.order === undefined ? {} : { order: options.order }),
            })
          ).registrationId,
        async (client, registrationId) => {
          await client.unregister({ registrationId });
        },
      );
    },
  };
};

/** A served hook handler: one `Handle` answer for a packed input. */
type ServedHook = (
  input: Any,
  call: Call,
) => Promise<MessageInitShape<typeof HookHandlerServiceHandleResponseSchema>>;

/**
 * The contract id, hook name and kind of the hook whose input is `input`;
 * a `TypeError` when it is not a hook input.
 */
const hookOf = (
  input: DescMessage,
): { contract: string; hook: string; kind: HookKind } => {
  if (
    !hasOption(input, hookOption) ||
    getOption(input, hookOption).kind === HookKind.UNSPECIFIED ||
    !hasOption(input.file, hooksOption)
  ) {
    throw new TypeError(`${input.typeName} is not the input of a hook.`);
  }

  const { name, kind } = getOption(input, hookOption);

  return { contract: getOption(input.file, hooksOption).id, hook: name, kind };
};

/** A decide handler's answer as a `Decision`; `invalid_output` when not one. */
const decisionOf = (hook: string, answer: object): Decision => {
  const refuse = (): never => {
    throw new ContractError(
      'invalid_output',
      `A ${hook} handler must answer a decision with a reason exactly when it refuses.`,
    );
  };

  if (isMessage(answer) && !isMessage(answer, DecisionSchema)) {
    return refuse();
  }

  const allow = 'allow' in answer ? answer.allow : undefined;
  const reason = 'reason' in answer ? answer.reason : undefined;

  if (
    (allow !== undefined && typeof allow !== 'boolean') ||
    (reason !== undefined && typeof reason !== 'string') ||
    (allow === true) === (reason !== undefined)
  ) {
    return refuse();
  }

  return create(DecisionSchema, {
    allow: allow === true,
    ...(reason === undefined ? {} : { reason }),
  });
};

/** The key a tool is served under: its name and Project. */
const toolKey = (name: string, projectId: string | undefined): string =>
  JSON.stringify([name, projectId ?? null]);

/** The key a hook handler is served under: its contract and hook. */
const hookKey = (contract: string, hook: string): string =>
  JSON.stringify([contract, hook]);

/** A `Value` as the JSON it holds; `null` when absent. */
const jsonOf = (value: Value | undefined): JsonValue =>
  value === undefined ? null : toJson(ValueSchema, value);

/**
 * `value` as a `Value` of what `JSON.stringify` writes; `undefined` when it
 * writes nothing, `invalid_output` when it throws.
 */
const asValue = (value: unknown): Value | undefined => {
  let text: string | undefined;

  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new ContractError(
      'invalid_output',
      `The result does not cross as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return text === undefined
    ? undefined
    : fromJson(ValueSchema, JSON.parse(text));
};

/** `tool.input.safeParse(payload)` as a payload check. */
const parsedPayload = (
  tool: ContractTool,
  payload: JsonValue,
): ToolPayloadCheck => {
  const parsed = tool.input.safeParse(payload);

  return parsed.success
    ? { success: true, data: parsed.data }
    : {
        success: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      };
};

/** A payload check as `Check`'s response. */
const checkResponseOf = (
  checked: ToolPayloadCheck,
): MessageInitShape<typeof ToolHandlerServiceCheckResponseSchema> => {
  if (!checked.success) {
    return {
      success: false,
      issues: checked.issues.map(({ path, message }) => ({ path, message })),
    };
  }

  const data = asValue(checked.data);

  return data === undefined ? { success: true } : { success: true, data };
};

/** One served entry of a {@link createTable} and its registration. */
interface Slot<E> {
  readonly value: E;
  /** Set once `Register` resolved. */
  tracked?: TrackedRegistration<string>;
}

/**
 * The entries a handler service serves by key, each registered with its
 * contract through `registrations.track` (see {@link ToolHandlers.register}
 * for the serving rules).
 */
const createTable = <E>() => {
  const slots = new Map<string, Slot<E>>();

  return {
    find: (key: string): E | undefined => slots.get(key)?.value,
    register: async <S extends DescService>(
      context: Pick<HostContext, 'registrations'>,
      key: string,
      value: E,
      service: S,
      register: (client: Client<S>) => Promise<string>,
      unregister: (client: Client<S>, registrationId: string) => Promise<void>,
    ): Promise<HandlerRegistration> => {
      const slot: Slot<E> = { value };
      let client: Client<S> | undefined;

      if (!slots.has(key)) {
        slots.set(key, slot);
      }

      let tracked: TrackedRegistration<string>;

      try {
        tracked = await context.registrations.track(service, (used) => {
          client = used;

          return register(used);
        });
      } catch (error) {
        if (slots.get(key) === slot) {
          slots.delete(key);
        }

        throw contractErrorOf(error);
      }

      const previous = slots.get(key);

      slot.tracked = tracked;
      slots.set(key, slot);

      if (previous !== slot) {
        previous?.tracked?.untrack();
      }

      return {
        get registrationId() {
          return tracked.current;
        },
        unregister: async () => {
          if (slots.get(key) !== slot) {
            return;
          }

          slots.delete(key);
          tracked.untrack();

          if (client !== undefined) {
            try {
              await unregister(client, tracked.current);
            } catch (error) {
              throw contractErrorOf(error);
            }
          }
        },
      };
    },
  };
};

/**
 * A routed call's failure as the caller should rethrow it: a `ConnectError`
 * (a `HostServices.use` client's failure) as the `ContractError`
 * `fromConnectError` reads (Doric code, message and details kept; `internal`
 * with the raw message when the error has no Doric detail); any other value
 * unchanged, the same object. Never throws. A handler that rethrows it
 * answers that code instead of `internal`.
 */
export const contractErrorOf = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;
