// The core's `tools/v1` over the router: tools as data, kept with the
// router-stamped registering instance under D4's key rule, and `Execute`
// relayed to that instance's `ToolHandlerService`.

import { create } from '@bufbuild/protobuf';
import type { Value } from '@bufbuild/protobuf/wkt';
import {
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import {
  type Call,
  ContractError,
  callOf,
  fromConnectError,
} from 'bundle/contracts';
import {
  type RegisteredTool,
  RegisteredToolSchema,
  ToolHandlerService,
  type ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  type BundleInstance,
  type RegistrationEntry,
  RegistrationTable,
  type StampedCaller,
  stampedCallerOf,
} from 'bundle/host';

import type { CoreBinding } from '../binding.js';

/** A routed service's registrations, as `activate`'s `InstanceGone` handler drops them. */
export interface InstanceRegistrations {
  /** Drops every registration of `instance`; never throws. */
  dropInstance(instance: BundleInstance): void;
}

/**
 * `tools/v1` as `createCoreServices` serves it. Tools are data, kept in a
 * `RegistrationTable<…>({ conflictCode: 'duplicate_tool' })` keyed
 * `name + '\u0000' + (projectId ?? '')`, with the stamped caller.
 *
 * - `Register`:
 *   - Refused with `duplicate_tool` and today's message (`Duplicate tool
 *     name "<name>": bundle "<holder>" and bundle "<caller>".`) when a
 *     serving registration of another key has the same name and an
 *     overlapping Project (the same `projectId`, or either one unscoped).
 *     A holder of the caller's own bundle refuses too.
 *   - Also refused when another bundle holds the same key.
 *   - A serving registration of an older instance of the caller's bundle
 *     (lower generation, or the same generation and a lower incarnation)
 *     never refuses.
 *   - The same instance and key again replace the tool and answer the same
 *     id.
 * - `Unregister`: removes the registration when the caller's bundle made
 *   it. An unknown id, or another bundle's, is a no-op.
 * - `List` and `Catalog`: the serving registrations the call sees (the
 *   unscoped ones, and those whose `projectId` equals `call.scope.projectId`),
 *   sorted by `order` ascending. Unordered ones come after, in the order
 *   their keys were first registered. `RegisteredTool.bundleId` is the
 *   registrant's.
 * - `Execute`:
 *   - The tool named `name` that the call sees, through
 *     `bind().handler(ToolHandlerService, registrant).execute({ name,
 *     projectId?, payload })`. Its `result` is answered as is.
 *   - `not_found` when the call sees no tool of that name.
 *   - A failure of the handler call reaches the caller with its Doric code
 *     (`fromConnectError`).
 *   - No deadline of its own: the relay inherits the `Execute` call's.
 * - `Check{name, payload}` (1.6.0):
 *   - The registration of `name` the call sees (the same lookup as
 *     `Execute`: unscoped tools and those of the call's `projectId`, newest
 *     instance per key); `not_found` ('Tool "<name>" is not registered.')
 *     when none, without calling anything.
 *   - Otherwise `ToolHandlerService.Check{name, projectId?, payload}` on the
 *     registering instance (`doric-target`), with the call's signal; its
 *     response is answered unchanged.
 *   - A failure of that call rejects as `fromConnectError` reads it (code,
 *     message and details kept), as `Execute` does.
 */
export const createToolsService = (
  bind: () => CoreBinding,
): {
  readonly implementation: ServiceImpl<typeof ToolsService>;
  readonly registrations: InstanceRegistrations;
} => {
  const table = new RegistrationTable<RegisteredTool>({
    conflictCode: 'duplicate_tool',
  });
  /** The bundle that made each registration still held, for `Unregister`. */
  const owners = new Map<string, string>();

  /** The serving registrations `call` sees, in `List` order. */
  const seen = (call: Call): readonly RegistrationEntry<RegisteredTool>[] => {
    const projectId = call.scope?.projectId;

    return table
      .entries()
      .filter(
        ({ value }) =>
          value.projectId === undefined || value.projectId === projectId,
      )
      .sort(byOrder);
  };

  /**
   * The `ToolHandlerService` call `Execute` and `Check` relay `name` to: the
   * registration of `name` the call sees, or `not_found`.
   */
  const relay = (
    name: string,
    payload: Value | undefined,
    context: HandlerContext,
  ) => {
    const binding = bind();
    const call = callOf(context);
    const entry = seen(call).find(({ value }) => value.tool?.name === name);

    if (entry === undefined) {
      throw new ContractError('not_found', `Tool "${name}" is not registered.`);
    }

    return {
      client: binding.handler(ToolHandlerService, entry.caller),
      request: {
        name,
        ...(entry.value.projectId === undefined
          ? {}
          : { projectId: entry.value.projectId }),
        ...(payload === undefined ? {} : { payload }),
      },
      options: { signal: call.signal },
    };
  };

  const implementation: ServiceImpl<typeof ToolsService> = {
    register: ({ tool, options }, context) => {
      bind();

      if (tool === undefined || options === undefined) {
        throw new ContractError(
          'invalid_input',
          'A tool and its options are required.',
        );
      }

      const caller = stampedCallerOf(context);
      const key = keyOf(tool.name, options.projectId);
      const holder = table
        .entries()
        .find(
          (entry) =>
            entry.value.tool?.name === tool.name &&
            overlaps(entry.value.projectId, options.projectId) &&
            !(entry.key === key && entry.caller.bundleId === caller.bundleId) &&
            !olderOf(entry.caller, caller),
        );

      if (holder !== undefined) {
        throw new ContractError(
          'duplicate_tool',
          `Duplicate tool name "${tool.name}": bundle "${holder.caller.bundleId}" and bundle "${caller.bundleId}".`,
        );
      }

      const { registrationId } = table.register(
        caller,
        key,
        create(RegisteredToolSchema, {
          bundleId: caller.bundleId,
          alwaysAvailable: options.alwaysAvailable,
          ...(options.order === undefined ? {} : { order: options.order }),
          ...(options.projectId === undefined
            ? {}
            : { projectId: options.projectId }),
          tool,
        }),
      );

      owners.set(registrationId, caller.bundleId);

      return { registrationId };
    },
    unregister: ({ registrationId }, context) => {
      bind();

      if (owners.get(registrationId) === callOf(context).caller.bundleId) {
        table.remove(registrationId);
        owners.delete(registrationId);
      }

      return {};
    },
    list: (_request, context) => {
      bind();

      return { tools: seen(callOf(context)).map(({ value }) => value) };
    },
    catalog: (_request, context) => {
      bind();

      return {
        entries: seen(callOf(context)).flatMap(({ value: { tool } }) =>
          tool === undefined
            ? []
            : [
                {
                  name: tool.name,
                  ...(tool.description === undefined
                    ? {}
                    : { description: tool.description }),
                  settings: tool.settings,
                },
              ],
        ),
      };
    },
    execute: async ({ name, payload }, context) => {
      try {
        const { client, request, options } = relay(name, payload, context);
        const { result } = await client.execute(request, options);

        return result === undefined ? {} : { result };
      } catch (error) {
        throw error instanceof ConnectError ? fromConnectError(error) : error;
      }
    },
    check: async ({ name, payload }, context) => {
      try {
        const { client, request, options } = relay(name, payload, context);
        const { success, data, issues } = await client.check(request, options);

        return data === undefined
          ? { success, issues }
          : { success, data, issues };
      } catch (error) {
        throw error instanceof ConnectError ? fromConnectError(error) : error;
      }
    },
  };

  return {
    implementation,
    registrations: {
      dropInstance: (instance) => table.dropInstance(instance),
    },
  };
};

/** A tool's key: its name, U+0000, and its Project or nothing. */
const keyOf = (name: string, projectId: string | undefined): string =>
  `${name}\u0000${projectId ?? ''}`;

/** Two Projects overlap when they are equal or either one is unscoped. */
const overlaps = (
  left: string | undefined,
  right: string | undefined,
): boolean => left === undefined || right === undefined || left === right;

/** Whether `holder` is an older instance of `caller`'s bundle. */
const olderOf = (holder: StampedCaller, caller: StampedCaller): boolean =>
  holder.bundleId === caller.bundleId &&
  (holder.generation < caller.generation ||
    (holder.generation === caller.generation &&
      holder.incarnation < caller.incarnation));

/** Ordered entries first, ascending; unordered ones keep their key order. */
const byOrder = (
  left: RegistrationEntry<RegisteredTool>,
  right: RegistrationEntry<RegisteredTool>,
): number =>
  (left.value.order ?? Number.POSITIVE_INFINITY) -
    (right.value.order ?? Number.POSITIVE_INFINITY) || 0;
