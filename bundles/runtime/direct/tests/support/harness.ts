import {
  type CallScope,
  defineMethod,
  defineService,
  ModelsV1,
  modelsMethods,
  type RegisteredSkill,
  type RegisteredTool,
  SkillsV1,
  skillsMethods,
  ToolsV1,
  toLanguageModel,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { ConfigurationV1, configurationMethods } from 'host-config/contracts';
import type { ProviderMessage } from 'llms';
import {
  type ConfigurationValue,
  ExecutorV1,
  type HistoryPatch,
  type HistoryReader,
  type InputSource,
  type PromptSession,
  type SteerInput,
  type Thread,
} from 'runtime/contracts';

import { activate } from '../../src/host/index.js';

export const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1603';
export const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
export const promptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1602';

/** The default host configuration's shape, as `host-config/v1` returns it. */
export const testConfiguration = (): ConfigurationValue => ({
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        endpoint: 'https://openrouter.ai/api/v1',
        token: 'credential-1',
      },
      models: [],
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'low',
    },
  },
  execution: { maxTurns: 32 },
  tools: {},
});

export const skill = (name: string, body: string) => ({
  name,
  description: `${name} description`,
  body,
  allowedTools: [],
  indexText: `${name} ${body}`,
});

/** What the runtime's session throws when a write fails: it keeps the retry. */
export class PersistenceFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly retry: () => Promise<void>,
  ) {
    super('Thread persistence failed.');
  }
}

export interface StoredEvent {
  readonly promptId: string;
  readonly sequence: number;
  readonly event: unknown;
}

/**
 * The Thread's stored executor state and log, written only through the
 * prompt session the way the runtime does: history first, then the event, and
 * on a failed write the retry saves the latest history and appends the
 * pending event.
 */
export const fakeThreadState = () => {
  let format: string | undefined;
  let parts: Record<string, unknown> = {};
  const events: StoredEvent[] = [];
  const writes: {
    readonly history?: HistoryPatch;
    readonly event?: unknown;
  }[] = [];
  /** Steering inputs that no run has taken yet. */
  const steering: SteerInput[] = [];
  let failWrite: ((entry: { readonly event?: unknown }) => boolean) | undefined;
  let onEvent: (event: unknown) => void = () => undefined;

  const reader = (): HistoryReader => ({
    get format() {
      return format;
    },
    read: (part) => Promise.resolve(structuredClone(parts[part])),
  });

  const apply = (patch: HistoryPatch) => {
    format = patch.format;
    parts = { ...parts, ...structuredClone(patch.parts) };
  };

  const append = (id: string, event: unknown) => {
    events.push({ promptId: id, sequence: events.length + 1, event });
    onEvent(event);
  };

  const session = (id: string): PromptSession => {
    let latest: HistoryPatch | undefined;
    let pending: unknown;
    const retry = async () => {
      if (latest !== undefined) apply(latest);
      if (pending !== undefined) {
        append(id, pending);
        pending = undefined;
      }
    };

    return {
      history: reader(),
      record: async (entry) => {
        writes.push(entry);
        if (entry.history !== undefined) latest = entry.history;
        if (entry.event !== undefined) pending = entry.event;
        if (failWrite?.(entry) === true) {
          throw new PersistenceFailure({ code: '53100' }, retry);
        }
        if (entry.history !== undefined) apply(entry.history);
        if (entry.event !== undefined) {
          append(id, entry.event);
          pending = undefined;
        }
      },
      steers: async () => steering.splice(0),
    };
  };

  return {
    events,
    writes,
    reader,
    session,
    apply,
    parts: () => parts,
    format: () => format,
    steer: (prompt: string, source: InputSource = { kind: 'user' }) => {
      steering.push({ prompt, source });
    },
    steering,
    failWhen: (test: typeof failWrite) => {
      failWrite = test;
    },
    onEvent: (listener: (event: unknown) => void) => {
      onEvent = listener;
    },
  };
};

export interface HarnessOptions {
  readonly configuration?: ConfigurationValue;
  readonly provider: object;
  readonly tools?: readonly RegisteredTool[];
  readonly skills?: readonly RegisteredSkill['skill'][];
}

/**
 * The `direct` bundle activated over fake `host-config/v1`, `models/v1`,
 * `tools/v1` and `skills/v1` providers, run through `executor/v1` the way the
 * runtime calls it: scoped to the prompt, with the prompt's abort signal.
 */
export const directServices = (options: HarnessOptions) => {
  const configuration = options.configuration ?? testConfiguration();
  const resolved: unknown[] = [];
  const languageModel = toLanguageModel(options.provider);
  const harness = createTestServices({
    bundle: { id: 'direct' },
    provide: [
      defineService(ConfigurationV1.id, {
        current: defineMethod({
          input: configurationMethods.current.input,
          output: configurationMethods.current.output,
          execute: () => ({
            configuration,
            revision: 1,
            updatedAt: new Date(0).toISOString(),
          }),
        }),
      }),
      defineService(ModelsV1.id, {
        resolve: defineMethod({
          input: modelsMethods.resolve.input,
          output: modelsMethods.resolve.output,
          execute: (request) => {
            resolved.push(request);
            if (
              !configuration.providers.some(
                ({ id }) => id === request.providerId,
              )
            ) {
              throw new Error('Configured provider is unavailable.');
            }
            return { ...request, languageModel };
          },
        }),
        // Basic contracts are provided whole; the executor reads none of these.
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
      defineService(ToolsV1.id, {
        register: defineMethod({
          input: toolsMethods.register.input,
          output: toolsMethods.register.output,
          execute: () => ({ dispose: () => undefined }),
        }),
        list: defineMethod({
          input: toolsMethods.list.input,
          output: toolsMethods.list.output,
          execute: () => options.tools ?? [],
        }),
        catalog: defineMethod({
          input: toolsMethods.catalog.input,
          output: toolsMethods.catalog.output,
          execute: async () =>
            (options.tools ?? []).map(({ tool }) => ({
              name: tool.name,
              settings: tool.settings,
            })),
        }),
      }),
      defineService(SkillsV1.id, {
        register: defineMethod({
          input: skillsMethods.register.input,
          output: skillsMethods.register.output,
          execute: () => ({ dispose: () => undefined }),
        }),
        list: defineMethod({
          input: skillsMethods.list.input,
          output: skillsMethods.list.output,
          execute: () =>
            (options.skills ?? []).map((value) => ({
              bundleId: 'test',
              alwaysAvailable: true,
              skill: value,
            })),
        }),
      }),
    ],
  });

  return {
    harness,
    resolved,
    activate: () => activate({ services: harness.services }),
    executor: (scope: CallScope) => harness.services.use(ExecutorV1, scope),
  };
};

export const thread = (): Thread => ({
  id: threadId,
  projectId,
  name: 'Main thread',
  state: 'running',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
});

/** Runs one prompt through `executor/v1`, as the runtime dispatcher does. */
export const runPrompt = async (
  services: ReturnType<typeof directServices>,
  state: ReturnType<typeof fakeThreadState>,
  prompt: string,
  {
    signal = new AbortController().signal,
    source = { kind: 'user' },
    id = promptId,
  }: {
    readonly signal?: AbortSignal;
    readonly source?: InputSource;
    readonly id?: string;
  } = {},
): Promise<string> => {
  const result = await services
    .executor({ projectId, threadId, promptId: id })
    .run(
      {
        thread: thread(),
        job: { id, prompt, source },
        session: state.session(id),
      },
      { signal },
    );

  return result.text;
};

/** The history a previous run (and the runtime's checkpoint) left. */
export const seedHistory = (
  state: ReturnType<typeof fakeThreadState>,
  value: {
    readonly messages?: readonly ProviderMessage[];
    readonly checkpoints?: Readonly<Record<string, number>>;
  },
): void => {
  const messages = value.messages ?? [];
  state.apply({
    format: 'direct.history/v1',
    parts: {
      messages,
      meta: {
        checkpoints: value.checkpoints ?? {},
        messageCount: messages.length,
      },
    },
  });
};
