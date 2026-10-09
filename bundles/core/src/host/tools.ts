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

/**
 * The core's `tools/v1`: one ordered registry of bound tools (activation order,
 * then call order) whose names are unique across bundles.
 */
export const createTools = () => {
  const registered: RegisteredTool[] = [];

  return defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: (
        [tool, options]: [ContractTool, { alwaysAvailable: boolean }],
        call,
      ): Disposable => {
        const bundleId = call.caller.bundleId;
        const taken = registered.find((entry) => entry.tool.name === tool.name);

        if (taken !== undefined) {
          throw new ContractError(
            'duplicate_tool',
            `Duplicate tool name "${tool.name}": bundle "${taken.bundleId}" and bundle "${bundleId}".`,
          );
        }

        const entry: RegisteredTool = Object.freeze({
          bundleId,
          alwaysAvailable: options.alwaysAvailable,
          tool,
        });

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
      execute: () => Object.freeze([...registered]),
    }),
  });
};
