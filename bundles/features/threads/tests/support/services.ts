import {
  type AnyServiceDefinition,
  type ContractTool,
  defineMethod,
  defineService,
  EventsV1,
  eventsMethods,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type AgentDefinition,
  DefaultAgentsV1,
  defaultAgentsMethods,
} from 'default/contracts';
import {
  RuntimeThreadsV1,
  runtimeThreadsMethods,
  type ThreadControl,
} from 'runtime/contracts';
import { isBoundTool, type Tool } from 'tool';

import { activate } from '../../src/host/index.js';

/** The Thread every tool call of these tests runs under. */
export const parentThreadId = 'parent-1';

/**
 * The boundary `thread-spawn` reads beyond `ThreadControl` when it is asked
 * for an agent. It reads neither `host-config/v1` nor `models/v1`: the harness
 * provides neither, so a read of either fails the call.
 */
export interface SpawnFakes {
  /** default.agents/v1.resolve; absent: no provider of default.agents/v1. */
  readonly agents?: (name: string) => AgentDefinition; // may throw a ContractError
  /** Receives ['agents.resolve', name]. */
  readonly calls?: unknown[][];
}

/** `default.agents/v1` only when the test gives an agents fake. */
const spawnProviders = (fakes: SpawnFakes): AnyServiceDefinition[] => {
  const calls = fakes.calls ?? [];
  const agents = fakes.agents;

  return agents === undefined
    ? []
    : [
        defineService(DefaultAgentsV1.id, {
          resolve: defineMethod({
            input: defaultAgentsMethods.resolve.input,
            output: defaultAgentsMethods.resolve.output,
            execute: ({ name }) => {
              calls.push(['agents.resolve', name]);
              return agents(name);
            },
          }),
        }),
      ];
};

/**
 * A fake `runtime.threads/v1` over a `ThreadControl`, forwarding each method
 * one to one exactly as the host adapter does, and a recording `tools/v1`.
 */
const providers = (
  control: ThreadControl,
  registered: ContractTool[],
  fakes: SpawnFakes,
  events: string[] = [],
) => [
  // Stage-1 controls only: the user-facing methods have no fake here.
  defineService(RuntimeThreadsV1.id, {
    spawn: defineMethod({
      input: runtimeThreadsMethods.spawn.input,
      output: runtimeThreadsMethods.spawn.output,
      execute: ([prompt, title, options]) =>
        control.spawn(prompt, title, options),
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
    restart: defineMethod({
      input: runtimeThreadsMethods.restart.input,
      output: runtimeThreadsMethods.restart.output,
      execute: ([threadId, prompt]) => control.restart(threadId, prompt),
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
  // An inert `events/v1`: activation registers its events, nothing is stored.
  defineService(EventsV1.id, {
    register: defineMethod({
      ...eventsMethods.register,
      execute: (definition) => {
        events.push(definition.type);
        return { dispose: () => undefined };
      },
    }),
    sink: defineMethod({
      ...eventsMethods.sink,
      execute: () => ({ dispose: () => undefined }),
    }),
    append: defineMethod({
      ...eventsMethods.append,
      execute: async () => undefined,
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
    catalog: defineMethod({
      input: toolsMethods.catalog.input,
      output: toolsMethods.catalog.output,
      execute: async () => [],
    }),
  }),
  ...spawnProviders(fakes),
];

/** What one activation did beyond registering tools. */
export interface ActivationRecord {
  /** Ids of the services the bundle provided, in order. */
  readonly provided: readonly string[];
  /** Types of the events it registered with `events/v1`, in order. */
  readonly events: readonly string[];
}

/**
 * Activates the bundle over the same fakes and records the services it
 * provides and the events it registers.
 */
export const activationRecord = async (): Promise<ActivationRecord> => {
  const provided: string[] = [];
  const events: string[] = [];
  const harness = createTestServices({
    bundle: { id: 'threads' },
    provide: providers({} as ThreadControl, [], {}, events),
  });
  const services = harness.services;

  await activate({
    services: {
      provide: (definition) => {
        provided.push(definition.id);
        return services.provide(definition);
      },
      use: (contract, scope) => services.use(contract, scope),
      whenAvailable: (contract, callback) =>
        services.whenAvailable(contract, callback),
    },
  });
  await harness.dispose();

  return { provided, events };
};

/**
 * Activates the bundle over the fakes and returns its registered tools as
 * the agent loop sees them for one prompt.
 */
export const activatedTools = async (
  control: ThreadControl,
  fakes: SpawnFakes = {},
): Promise<readonly Tool[]> => {
  const registered: ContractTool[] = [];
  const harness = createTestServices({
    bundle: { id: 'threads' },
    provide: providers(control, registered, fakes),
  });

  await activate({ services: harness.services });

  const call = harness.call({
    projectId: 'project-1',
    threadId: parentThreadId,
    promptId: 'prompt-1',
  });

  return registered.map((tool) => {
    if (!isBoundTool(tool)) {
      throw new TypeError(`tools/v1 received an unbound tool: ${tool.name}`);
    }

    return tool.toTool(call);
  });
};
