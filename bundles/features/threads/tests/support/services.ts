import {
  type AnyServiceDefinition,
  type ContractTool,
  defineMethod,
  defineService,
  EventsV1,
  eventsMethods,
  ModelsV1,
  modelsMethods,
  ToolsV1,
  toLanguageModel,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type AgentDefinition,
  DefaultAgentsV1,
  defaultAgentsMethods,
} from 'default/contracts';
import {
  ConfigurationV1,
  type ConfigurationValue,
  configurationMethods,
} from 'host-config/contracts';
import {
  type ReasoningEffort,
  RuntimeThreadsV1,
  runtimeThreadsMethods,
  type Thread,
  type ThreadControl,
} from 'runtime/contracts';
import { isBoundTool, type Tool } from 'tool';

import { activate } from '../../src/host/index.js';

/** The Thread every tool call of these tests runs under. */
export const parentThreadId = 'parent-1';

/**
 * The boundaries `thread-spawn` reads beyond `ThreadControl` when it is asked
 * for an agent, a model or an effort.
 */
export interface SpawnFakes {
  /** default.agents/v1.resolve; absent: no provider of default.agents/v1. */
  readonly agents?: (name: string) => AgentDefinition; // may throw a ContractError
  /** The calling thread ('parent-1') record's model/effort. */
  readonly parent?: {
    readonly model?: string;
    readonly effort?: ReasoningEffort;
  };
  /**
   * Default: provider 'openai' with models [{name:'gpt-5',
   * reasonings:['low','medium','high']}, {name:'gpt-5-mini'}]; execution
   * {providerId:'openai', model:'gpt-5-mini', effort:'medium'}.
   */
  readonly configuration?: Pick<ConfigurationValue, 'providers' | 'models'>;
  /**
   * Receives ['agents.resolve', name] | ['thread', id] |
   * ['configuration.current'] | ['models.resolve', request].
   */
  readonly calls?: unknown[][];
}

export const defaultConfiguration: Pick<
  ConfigurationValue,
  'providers' | 'models'
> = {
  providers: [
    {
      id: 'openai',
      kind: 'openai',
      configuration: {},
      models: [
        { name: 'gpt-5', reasonings: ['low', 'medium', 'high'] },
        { name: 'gpt-5-mini' },
      ],
    },
  ],
  models: {
    execution: { providerId: 'openai', model: 'gpt-5-mini', effort: 'medium' },
  },
};

/** The calling Thread's full record, with the parent's model and effort. */
const parentRecord = (parent: SpawnFakes['parent']): Thread => ({
  id: parentThreadId,
  projectId: 'project-1',
  name: 'Parent',
  state: 'running',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...(parent?.model === undefined ? {} : { model: parent.model }),
  ...(parent?.effort === undefined ? {} : { effort: parent.effort }),
});

/**
 * `host-config/v1` (`current` only), `models/v1` provided whole, and
 * `default.agents/v1` only when the test gives an agents fake.
 */
const spawnProviders = (fakes: SpawnFakes): AnyServiceDefinition[] => {
  const calls = fakes.calls ?? [];
  const configuration: ConfigurationValue = {
    ...(fakes.configuration ?? defaultConfiguration),
    execution: { maxTurns: 10 },
  };
  const agents = fakes.agents;

  return [
    defineService(ConfigurationV1.id, {
      current: defineMethod({
        input: configurationMethods.current.input,
        output: configurationMethods.current.output,
        execute: () => {
          calls.push(['configuration.current']);
          return {
            configuration,
            revision: 1,
            updatedAt: new Date(0).toISOString(),
          };
        },
      }),
    }),
    defineService(ModelsV1.id, {
      resolve: defineMethod({
        input: modelsMethods.resolve.input,
        output: modelsMethods.resolve.output,
        execute: (request) => {
          calls.push(['models.resolve', request]);
          if (
            !configuration.providers.some(({ id }) => id === request.providerId)
          ) {
            throw new Error('Configured provider is unavailable.');
          }
          return { ...request, languageModel: toLanguageModel({}) };
        },
      }),
      // Basic contracts are provided whole; thread-spawn reads none of these.
      kinds: defineMethod({
        input: modelsMethods.kinds.input,
        output: modelsMethods.kinds.output,
        execute: () => [],
      }),
      kind: defineMethod({
        input: modelsMethods.kind.input,
        output: modelsMethods.kind.output,
        execute: () => undefined,
      }),
      catalog: defineMethod({
        input: modelsMethods.catalog.input,
        output: modelsMethods.catalog.output,
        execute: () => ({ status: 'absent' as const }),
      }),
      prepare: defineMethod({
        input: modelsMethods.prepare.input,
        output: modelsMethods.prepare.output,
        execute: () => undefined,
      }),
      contextWindow: defineMethod({
        input: modelsMethods.contextWindow.input,
        output: modelsMethods.contextWindow.output,
        execute: () => undefined,
      }),
    }),
    ...(agents === undefined
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
        ]),
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
) => [
  // Stage-1 controls only: the user-facing methods have no fake here.
  defineService(RuntimeThreadsV1.id, {
    thread: defineMethod({
      ...runtimeThreadsMethods.thread,
      execute: async (id: string) => {
        fakes.calls?.push(['thread', id]);
        return id === parentThreadId ? parentRecord(fakes.parent) : undefined;
      },
    }),
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
      execute: () => ({ dispose: () => undefined }),
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
