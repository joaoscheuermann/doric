import {
  bindRegistrant,
  type Call,
  type ContractTool,
  isContractError,
  type Registrable,
  type Services,
} from 'bundle/contracts';
import { type AgentDefinition, DefaultAgentsV1 } from 'default/contracts';
import { RuntimeThreadsV1, type ThreadControl } from 'runtime/contracts';
import type { ToolInput, ToolOutput, UnboundTool } from 'tool';

/** What a delegation tool reaches, per call. */
export interface ThreadToolPorts {
  /**
   * The direct-child controls of the prompt `call` belongs to
   * (`runtime.threads/v1` `Spawn`…`Terminate` under `call`'s scope). Each
   * method answers the kernel's value and rejects with the provider's
   * `ContractError` (code, message and details kept).
   */
  controls(call: Call): ThreadControl;
  /**
   * `default.agents/v1.Resolve{name}` under `call`. When no provider of
   * `default.agents/v1` can answer, rejects with
   * `Error('Agent types are unavailable in this runtime.')`; every other
   * failure unchanged (`not_found`, `invalid_definition`, `invalid_input`).
   */
  resolveAgent(name: string, call: Call): Promise<AgentDefinition>;
}

/**
 * The ports over the kernel `Services`: `services.use(RuntimeThreadsV1,
 * call.scope)` with `call` passed to each control, and
 * `services.use(DefaultAgentsV1, call.scope).resolve` with today's mapping of
 * `unavailable` + `details.contract === 'default.agents/v1'`. Kernel-only.
 */
export const kernelThreadToolPorts = (services: Services): ThreadToolPorts => ({
  controls: (call) => {
    const threads = services.use(RuntimeThreadsV1, call.scope);

    return {
      spawn: (prompt, title, options) =>
        threads.spawn(prompt, title, options, call),
      list: (limit, cursor) => threads.list(limit, cursor, call),
      get: (threadId) => threads.get(threadId, call),
      events: (threadId, afterSequence, limit) =>
        threads.events(threadId, afterSequence, limit, call),
      send: (threadId, prompt) => threads.send(threadId, prompt, call),
      restart: (threadId, prompt) => threads.restart(threadId, prompt, call),
      interrupt: (threadId, promptId) =>
        threads.interrupt(threadId, promptId, call),
      terminate: (threadId) => threads.terminate(threadId, call),
    };
  },
  resolveAgent: async (name, call) => {
    try {
      return await services
        .use(DefaultAgentsV1, call.scope)
        .resolve({ name }, call);
    } catch (error) {
      if (
        isContractError(error) &&
        error.code === 'unavailable' &&
        typeof error.details === 'object' &&
        error.details !== null &&
        'contract' in error.details &&
        error.details.contract === DefaultAgentsV1.id
      ) {
        throw new Error('Agent types are unavailable in this runtime.');
      }
      throw error;
    }
  },
});

/**
 * A kernel `Registrable` of `definition`: its `[bindRegistrant](services)`
 * answers `definition.bind(kernelThreadToolPorts(services))`, as the kernel's
 * `tools/v1` binds every `Registrable` with the registering bundle's
 * `Services`. Kernel-only.
 */
export const kernelRegistrable = (
  definition: UnboundTool<ToolInput, ToolOutput, ThreadToolPorts>,
): Registrable<ContractTool> => ({
  [bindRegistrant]: (services) =>
    definition.bind(kernelThreadToolPorts(services)),
});
