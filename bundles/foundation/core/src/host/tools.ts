import {
  type Call,
  ContractError,
  type ContractTool,
  type Disposable,
  defineMethod,
  defineService,
  type RegisteredTool,
  type Services,
  type ToolRegistrationOptions,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';

import { collidesIn, seenBy, viewOf } from '../shared/partition.js';

interface Entry {
  readonly generation: number;
  readonly registered: RegisteredTool;
}

/** Ordered entries first, by key; ties and unordered keep registration order. */
const byOrder = (
  left: { readonly registered: { readonly order?: number } },
  right: { readonly registered: { readonly order?: number } },
): number =>
  (left.registered.order ?? Number.POSITIVE_INFINITY) -
    (right.registered.order ?? Number.POSITIVE_INFINITY) || 0;

/**
 * The core's `tools/v1`: one ordered registry of bound tools (the global
 * `order` key, then activation order, then call order; 1.2.0) whose names are unique across the bundles one generation
 * view sees (D4-11): the kernel partition plus one generation.
 */
export const createTools = () => {
  const registered: Entry[] = [];

  /** The registered tools one call's generation view sees, in order. */
  const seen = (call: Call, services: Services) => {
    const view = viewOf(call, services);

    return registered
      .filter((entry) => seenBy(entry.generation, view))
      .sort(byOrder)
      .map((entry) => entry.registered);
  };

  return defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: (
        [tool, options]: [ContractTool, ToolRegistrationOptions],
        call,
        services,
      ): Disposable => {
        const bundleId = call.caller.bundleId;
        const view = viewOf(call, services);
        const taken = registered.find(
          (entry) =>
            entry.registered.tool.name === tool.name &&
            collidesIn(entry.generation, view),
        )?.registered;

        if (taken !== undefined) {
          throw new ContractError(
            'duplicate_tool',
            `Duplicate tool name "${tool.name}": bundle "${taken.bundleId}" and bundle "${bundleId}".`,
          );
        }

        const entry: Entry = {
          generation: view.generation,
          registered: Object.freeze({
            bundleId,
            alwaysAvailable: options.alwaysAvailable,
            ...(options.order === undefined ? {} : { order: options.order }),
            tool,
          }),
        };

        registered.push(entry);

        let disposed = false;

        return {
          dispose: () => {
            if (disposed) {
              return;
            }

            disposed = true;

            const index = registered.indexOf(entry);

            if (index >= 0) {
              registered.splice(index, 1);
            }
          },
        };
      },
    }),
    list: defineMethod({
      input: toolsMethods.list.input,
      output: toolsMethods.list.output,
      execute: (_input, call, services) => Object.freeze(seen(call, services)),
    }),
    // GET /tools as data: the same entries the transport route answers.
    catalog: defineMethod({
      input: toolsMethods.catalog.input,
      output: toolsMethods.catalog.output,
      execute: async (_input, call, services) =>
        seen(call, services).map(({ tool }) => ({
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          settings: tool.settings,
        })),
    }),
  });
};
