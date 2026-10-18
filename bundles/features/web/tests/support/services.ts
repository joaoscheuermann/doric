import {
  type ContractTool,
  defineMethod,
  defineService,
  type ToolRegistrationOptions,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  isBoundTool,
  type Tool,
  type ToolDefinitionObject,
  type ToolInput,
  type ToolOutput,
} from 'tool';

import { activate } from '../../src/host/index.js';

/** One `tools/v1.register` call the fake registry received. */
export interface Registration {
  readonly tool: ContractTool;
  readonly options: ToolRegistrationOptions;
}

/** A recording `tools/v1`, standing for the core's registry. */
const registry = (registered: Registration[]) =>
  defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: ([tool, options]) => {
        registered.push({ tool, options });

        return { dispose: () => undefined };
      },
    }),
    list: defineMethod({
      input: toolsMethods.list.input,
      output: toolsMethods.list.output,
      execute: () => [],
    }),
    catalog: defineMethod({
      input: toolsMethods.catalog.input,
      output: toolsMethods.catalog.output,
      execute: async () => [],
    }),
  });

const harness = (registered: Registration[] = []) =>
  createTestServices({
    bundle: { id: 'web' },
    provide: [registry(registered)],
  });

const promptCall = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

/**
 * Activates the bundle over the fake registry and returns what it registered,
 * each tool as the agent loop sees it for one prompt.
 */
export const activated = async (): Promise<
  readonly (Registration & { readonly bound: Tool })[]
> => {
  const registered: Registration[] = [];
  const test = harness(registered);

  await activate({ services: test.services });

  const call = test.call(promptCall);

  return registered.map((entry) => {
    if (!isBoundTool(entry.tool)) {
      throw new TypeError(
        `tools/v1 received an unbound tool: ${entry.tool.name}`,
      );
    }

    return { ...entry, bound: entry.tool.toTool(call) };
  });
};

/** Binds a tool definition to the bundle's services for one prompt. */
export const bindTool = <I extends ToolInput, O extends ToolOutput>(
  definition: ToolDefinitionObject<I, O>,
): Tool<I, O> => {
  const test = harness();

  return definition.bind(test.services).toTool(test.call(promptCall));
};
