import {
  ContractError,
  type ContractTool,
  type Disposable,
  defineMethod,
  defineService,
  type RegisteredTool,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';

import { collidesIn, seenBy, viewOf } from './partition.js';

interface Entry {
  readonly generation: number;
  readonly registered: RegisteredTool;
}

/**
 * The core's `tools/v1`: one ordered registry of bound tools (activation order,
 * then call order) whose names are unique across the bundles one generation
 * view sees (D4-11): the kernel partition plus one generation.
 */
export const createTools = () => {
  const registered: Entry[] = [];

  return defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: (
        [tool, options]: [ContractTool, { alwaysAvailable: boolean }],
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
      execute: (_input, call, services) => {
        const view = viewOf(call, services);

        return Object.freeze(
          registered
            .filter((entry) => seenBy(entry.generation, view))
            .map((entry) => entry.registered),
        );
      },
    }),
  });
};
