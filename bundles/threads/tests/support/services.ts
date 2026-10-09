import {
  type ContractTool,
  defineMethod,
  defineService,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import type { ThreadControl } from 'host';
import { RuntimeThreadsV1, runtimeThreadsMethods } from 'runtime/contracts';
import { isBoundTool, type Tool } from 'tool';

import { activate } from '../../src/host/index.js';

/**
 * A fake `runtime.threads/v1` over a `ThreadControl`, forwarding each method
 * one to one exactly as the host adapter does, and a recording `tools/v1`.
 */
const providers = (control: ThreadControl, registered: ContractTool[]) => [
  defineService(RuntimeThreadsV1, {
    spawn: defineMethod({
      input: runtimeThreadsMethods.spawn.input,
      output: runtimeThreadsMethods.spawn.output,
      execute: (prompt) => control.spawn(prompt),
    }),
    list: defineMethod({
      input: runtimeThreadsMethods.list.input,
      output: runtimeThreadsMethods.list.output,
      execute: ([limit, cursor]) => control.list(limit, cursor),
    }),
    get: defineMethod({
      input: runtimeThreadsMethods.get.input,
      output: runtimeThreadsMethods.get.output,
      execute: (threadId) => control.get(threadId),
    }),
    events: defineMethod({
      input: runtimeThreadsMethods.events.input,
      output: runtimeThreadsMethods.events.output,
      execute: ([threadId, afterSequence, limit]) =>
        control.events(threadId, afterSequence, limit),
    }),
    send: defineMethod({
      input: runtimeThreadsMethods.send.input,
      output: runtimeThreadsMethods.send.output,
      execute: ([threadId, prompt]) => control.send(threadId, prompt),
    }),
    interrupt: defineMethod({
      input: runtimeThreadsMethods.interrupt.input,
      output: runtimeThreadsMethods.interrupt.output,
      execute: ([threadId, promptId]) => control.interrupt(threadId, promptId),
    }),
    terminate: defineMethod({
      input: runtimeThreadsMethods.terminate.input,
      output: runtimeThreadsMethods.terminate.output,
      execute: (threadId) => control.terminate(threadId),
    }),
  }),
  defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: ([tool]) => {
        registered.push(tool);

        return { dispose: () => undefined };
      },
    }),
    list: defineMethod({
      input: toolsMethods.list.input,
      output: toolsMethods.list.output,
      execute: () => [],
    }),
  }),
];

/**
 * Activates the bundle over the fakes and returns its registered tools as
 * the agent loop sees them for one prompt.
 */
export const activatedTools = async (
  control: ThreadControl,
): Promise<readonly Tool[]> => {
  const registered: ContractTool[] = [];
  const harness = createTestServices({
    bundle: { id: 'threads' },
    provide: providers(control, registered),
  });

  await activate({ services: harness.services });

  const call = harness.call({
    projectId: 'project-1',
    threadId: 'parent-1',
    promptId: 'prompt-1',
  });

  return registered.map((tool) => {
    if (!isBoundTool(tool)) {
      throw new TypeError(`tools/v1 received an unbound tool: ${tool.name}`);
    }

    return tool.toTool(call);
  });
};
