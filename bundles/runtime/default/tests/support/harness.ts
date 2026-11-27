import {
  type AnyHookHandler,
  type Call,
  type CallScope,
  defineMethod,
  defineService,
  HooksV1,
  hooksMethods,
  logMethods,
  ModelsV1,
  modelsMethods,
  type RegisteredSkill,
  type RegisteredTool,
  type Services,
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
  type AttachmentContent,
  type ConfigurationValue,
  type CwdRepo,
  type ExecutorThread,
  ExecutorV1,
  executorMethods,
  type HistoryPatch,
  type HistoryReader,
  type InputSource,
  type LeaseDescription,
  type LeaseExecInput,
  type LeaseExecResult,
  type PromptSession,
  RuntimeLeaseV1,
  RuntimeWorkspaceV1,
  runtimeLeaseMethods,
  runtimeWorkspaceMethods,
  type SteerInput,
} from 'runtime/contracts';
import { z } from 'zod';

import {
  DefaultAgentsV1,
  DefaultHooksV1,
  defaultAgentsMethods,
  type SkillSourceEntry,
  SkillSourcesV1,
  skillSourcesMethods,
} from '../../src/contracts/index.js';
import type { AgentFile } from '../../src/host/agents/built-in.js';
import {
  agentsMethods,
  loadBuiltInAgents,
} from '../../src/host/agents/definitions.js';
import { compactThread } from '../../src/host/compact.js';
import { runPrompt as runExecutorPrompt } from '../../src/host/executor.js';
import {
  checkpoint,
  historyFormat,
  legacyHistoryFormat,
  rewind,
} from '../../src/host/history.js';
import {
  createRunVariables,
  type PromptVariables,
} from '../../src/host/prompts/variables.js';
import { installBundleAssets } from './assets.js';
import { kernelBeforeModelRequest, kernelPorts } from './envelope-ports.js';

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
  // A fixed zone, so a run's date line does not follow the host's zone.
  profile: { timezone: 'UTC' },
});

/** The clock every harness runs on unless a test gives its own. */
export const harnessNow = new Date('2026-03-01T12:00:00.000Z');

/**
 * The prompt variables of a default harness run: `testConfiguration()`'s UTC
 * zone at `harnessNow`, no user name, and no lease to probe an OS on.
 */
export const harnessVariables: PromptVariables = {
  date: '2026-03-01',
  timezone: 'UTC',
};

/**
 * A skill `skills/v1` lists. `alwaysAvailable` defaults to true, as every
 * skill was before the skill catalog: its body stays in the system prompt.
 */
export type HarnessSkill = RegisteredSkill['skill'] & {
  readonly alwaysAvailable?: boolean;
};

export const skill = (
  name: string,
  body: string,
  options: {
    readonly alwaysAvailable?: boolean;
    readonly description?: string;
  } = {},
): HarnessSkill => ({
  name,
  description: options.description ?? `${name} description`,
  body,
  allowedTools: [],
  indexText: `${name} ${body}`,
  ...(options.alwaysAvailable === undefined
    ? {}
    : { alwaysAvailable: options.alwaysAvailable }),
});

/**
 * The system-prompt section of the one always-available skill
 * `skill('sandbox', 'Inspect before reporting.')`, as the skill catalog
 * renders it.
 */
export const sandboxSection = [
  '# Skills',
  '## Always-available skills\n\nFollow these skills whenever they apply.',
  '### Skill: sandbox\n\nInspect before reporting.',
].join('\n\n');

/** One call a fake boundary provider received, with the scope it ran under. */
export interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
  readonly scope: CallScope | undefined;
}

/** The sandbox the prompt's Project leases, as `runtime.lease/v1` answers. */
export interface FakeLease {
  /** Default: the call rejects, so a run probes no OS. */
  readonly describe?: () => LeaseDescription | Promise<LeaseDescription>;
  /** Default: exit 0 with no output. */
  readonly exec?: (
    input: LeaseExecInput,
  ) => LeaseExecResult | Promise<LeaseExecResult>;
  /** Default: the file does not exist. */
  readonly readFile?: (path: string) => string | Promise<string>;
}

/** Whether `input` is the run's OS probe, the exec that runs `uname -srm`. */
export const isOsProbe = (input: LeaseExecInput): boolean =>
  input.cmd.some((part) => part.includes('uname -srm'));

/**
 * A lease `lease-1` whose OS probe prints `uname` on its first line and
 * `prettyName` on its second; every other exec exits 0 with no output.
 */
export const osLease = (
  uname = 'Linux 6.8.0 x86_64',
  prettyName = 'Ubuntu 24.04 LTS',
): FakeLease => ({
  describe: () => ({ id: 'lease-1', root: '/workspace' }),
  exec: (input) =>
    isOsProbe(input)
      ? { exitCode: 0, stdout: `${uname}\n${prettyName}\n`, stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' },
});

/**
 * One bundle's skills, as its `default.skill-sources/v1` provider answers.
 * `list` answers whatever the test gives, valid or not, so a test can check
 * what `default` does with an answer that fails the contract's schema.
 */
export interface FakeSkillSource {
  /** Default: no skill. */
  readonly list?: (input: { readonly cwd: string }) => unknown;
  /** Default: the skill cannot be read. */
  readonly read?: (input: {
    readonly reference: string;
  }) =>
    | { readonly origin?: string; readonly text: string }
    | Promise<{ readonly origin?: string; readonly text: string }>;
}

/** The Thread's live working directory, as `runtime.workspace/v1` answers. */
export interface FakeWorkspace {
  /** Read on every call, so a test can move the directory mid-run. */
  cwd(): string | Promise<string>;
}

const recorder =
  (calls: RecordedCall[], method: string) => (input: unknown, call: Call) => {
    calls.push({ method, input, scope: call.scope });
  };

/** One entry the fake `log/v1` received. */
export interface LoggedEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** A fake `log/v1` that pushes every entry to `logs`. */
export const logService = (logs: LoggedEntry[]) => {
  const level = (name: LoggedEntry['level']) =>
    defineMethod({
      ...logMethods[name],
      execute: ([message, fields]) => {
        logs.push({
          level: name,
          message,
          ...(fields === undefined ? {} : { fields }),
        });
      },
    });
  return defineService('log/v1', {
    debug: level('debug'),
    info: level('info'),
    warn: level('warn'),
    error: level('error'),
  });
};

/** A fake `runtime.workspace/v1` (cwd only) recording every call. */
export const workspaceService = (
  workspace: FakeWorkspace,
  calls: RecordedCall[],
) =>
  defineService(RuntimeWorkspaceV1.id, {
    cwd: defineMethod({
      input: runtimeWorkspaceMethods.cwd.input,
      output: runtimeWorkspaceMethods.cwd.output,
      execute: async (input, call) => {
        recorder(calls, 'cwd')(input, call);
        return workspace.cwd();
      },
    }),
  });

/** `skills/v1` listing `skills` in order, each from the bundle `test`. */
export const skillsService = (skills: readonly HarnessSkill[]) =>
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
        skills.map(({ alwaysAvailable = true, ...value }) => ({
          bundleId: 'test',
          alwaysAvailable,
          skill: value,
        })),
    }),
  });

/** A fake `runtime.lease/v1` (describe, exec, readFile) recording every call. */
export const leaseService = (lease: FakeLease, calls: RecordedCall[]) =>
  defineService(RuntimeLeaseV1.id, {
    describe: defineMethod({
      input: runtimeLeaseMethods.describe.input,
      output: runtimeLeaseMethods.describe.output,
      execute: async (input, call) => {
        recorder(calls, 'describe')(input, call);
        if (lease.describe === undefined)
          throw new Error('The lease cannot be described.');
        return lease.describe();
      },
    }),
    exec: defineMethod({
      input: runtimeLeaseMethods.exec.input,
      output: runtimeLeaseMethods.exec.output,
      execute: async (input, call) => {
        recorder(calls, 'exec')(input, call);
        return (
          (await lease.exec?.(input)) ?? { exitCode: 0, stdout: '', stderr: '' }
        );
      },
    }),
    readFile: defineMethod({
      input: runtimeLeaseMethods.readFile.input,
      output: runtimeLeaseMethods.readFile.output,
      execute: async (path, call) => {
        recorder(calls, 'readFile')(path, call);
        if (lease.readFile === undefined)
          throw new Error(`No such file: ${path}`);
        return lease.readFile(path);
      },
    }),
  });

/**
 * A fake provider of the many-contract `default.skill-sources/v1` (list,
 * read) recording every call. Its `list` output schema is loose: the fake
 * answers what `source.list` gives, and `default` checks it.
 */
export const skillSourceService = (
  source: FakeSkillSource,
  calls: RecordedCall[],
) =>
  defineService(
    SkillSourcesV1.id,
    {
      list: defineMethod({
        input: skillSourcesMethods.list.input,
        output: z.unknown(),
        execute: async (input, call) => {
          recorder(calls, 'list')(input, call);
          return (await source.list?.(input)) ?? { skills: [] };
        },
      }),
      read: defineMethod({
        ...skillSourcesMethods.read,
        execute: async (input, call) => {
          recorder(calls, 'read')(input, call);
          if (source.read === undefined)
            throw new Error(`The skill ${input.reference} cannot be read.`);
          return source.read(input);
        },
      }),
    },
    { cardinality: 'many' },
  );

/**
 * One skill a source lists: `description` defaults to `<name> description.`
 * and `reference` to `<group>/<name>` (or `<name>` without a group).
 */
export const sourceEntry = (
  name: string,
  options: {
    readonly group?: string;
    readonly description?: string;
    readonly reference?: string;
  } = {},
): SkillSourceEntry => ({
  ...(options.group === undefined ? {} : { group: options.group }),
  name,
  description: options.description ?? `${name} description.`,
  reference:
    options.reference ??
    (options.group === undefined ? name : `${options.group}/${name}`),
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
  /** The attachments the Thread's Project holds, by id. */
  const attachments = new Map<string, AttachmentContent>();
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
      attachment: async (attachmentId) => attachments.get(attachmentId),
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
    attach: (content: AttachmentContent) => {
      attachments.set(content.id, content);
    },
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
  readonly skills?: readonly HarnessSkill[];
  /** A `runtime.lease/v1` provider; without it the contract is unprovided. */
  readonly lease?: FakeLease;
  /**
   * The `default.skill-sources/v1` providers, by the bundle id each provides
   * from, in order; without it the contract is unprovided.
   */
  readonly sources?: Readonly<Record<string, FakeSkillSource>>;
  /** The bundle's clock. Default: always `harnessNow`. */
  readonly now?: () => Date;
  /** The built-in agent files `activate` loads (`provideEnvelope`). Default: none (`[]`), so tests see only the agents they inject; pass `builtInAgentFiles()` for the shipped ones. */
  readonly builtInAgents?: readonly AgentFile[];
  /** A `runtime.workspace/v1` provider; without it the contract is unprovided. */
  readonly workspace?: FakeWorkspace;
  /**
   * What `models/v1.inputModalities` answers for every model. Default:
   * `undefined`, a catalog that does not say.
   */
  readonly inputModalities?: readonly string[];
}

/**
 * A `hooks/v1` that runs every handler of a hook in registration order: a
 * transform hook's handler takes the previous one's output, as the core's
 * provider does, and an observe hook's handlers all take the input.
 */
const transformHooks = () => {
  const handlers = new Map<string, AnyHookHandler[]>();
  const none = { dispose: () => undefined };

  return defineService(HooksV1, {
    define: defineMethod({ ...hooksMethods.define, execute: () => none }),
    register: defineMethod({
      ...hooksMethods.register,
      execute: ([contract, hook, handler]) => {
        const key = `${contract.id}#${hook}`;
        handlers.set(key, [...(handlers.get(key) ?? []), handler]);
        return none;
      },
    }),
    whenDefined: defineMethod({
      ...hooksMethods.whenDefined,
      execute: ([, callback]) => {
        callback();
        return none;
      },
    }),
    execute: defineMethod({
      ...hooksMethods.execute,
      execute: async ([contract, hook, input], call) => {
        const transform = contract.hooks[hook]?.kind === 'transform';
        let value = input;
        for (const handler of handlers.get(`${contract.id}#${hook}`) ?? []) {
          const result = await handler(value, call);
          if (transform) value = result;
        }
        return transform ? value : undefined;
      },
    }),
  });
};

/**
 * `default`'s envelope services over its own factories, as the kernel entry
 * provided them (S68d, Q-F1): loads the built-in agents first and throws
 * `loadBuiltInAgents`' Error, providing nothing, when one is invalid; then
 * defines `default.hooks/v1` and provides `default.agents/v1` and
 * `executor/v1` over {@link kernelPorts}. Every model request of a run first
 * passes its system prompt through `onBeforeModelRequestHook`.
 */
const provideEnvelope = (
  services: Services,
  options: {
    readonly now: () => Date;
    readonly builtInAgents: readonly AgentFile[];
  },
): void => {
  const builtIn = loadBuiltInAgents(options.builtInAgents);
  const hooks = services.use(HooksV1).define(DefaultHooksV1);
  const agents = agentsMethods(builtIn);
  const runVariables = createRunVariables(options.now);
  const beforeModelRequest = kernelBeforeModelRequest(hooks);

  services.provide(
    defineService(DefaultAgentsV1, {
      list: defineMethod({
        ...defaultAgentsMethods.list,
        execute: (_input, call, used) => agents.list(call, kernelPorts(used)),
      }),
      resolve: defineMethod({
        ...defaultAgentsMethods.resolve,
        execute: ({ name }, call, used) =>
          agents.resolve(name, call, kernelPorts(used)),
      }),
    }),
  );
  // Defined by id: the run's loose output schema does not match the typed
  // overload's exact result type.
  services.provide(
    defineService(ExecutorV1.id, {
      run: defineMethod({
        input: executorMethods.run.input,
        output: executorMethods.run.output,
        execute: (input, call, used) =>
          runExecutorPrompt(
            input,
            call,
            kernelPorts(used),
            beforeModelRequest,
            runVariables,
            builtIn,
          ),
      }),
      checkpoint: defineMethod({
        input: executorMethods.checkpoint.input,
        output: executorMethods.checkpoint.output,
        execute: (input) => checkpoint(input),
      }),
      rewind: defineMethod({
        input: executorMethods.rewind.input,
        output: executorMethods.rewind.output,
        execute: (input) => rewind(input),
      }),
      formats: defineMethod({
        input: executorMethods.formats.input,
        output: executorMethods.formats.output,
        execute: () => [historyFormat, legacyHistoryFormat],
      }),
      compact: defineMethod({
        input: executorMethods.compact.input,
        output: executorMethods.compact.output,
        execute: (input, call, used) =>
          compactThread(input, call, kernelPorts(used)),
      }),
    }),
  );
};

/**
 * The `default` bundle activated over fake `host-config/v1`, `models/v1`,
 * `tools/v1` and `skills/v1` providers (and, when given, `runtime.lease/v1`,
 * `default.skill-sources/v1` and `runtime.workspace/v1`), run through `executor/v1` the way the runtime calls it:
 * scoped to the prompt, with the prompt's abort signal.
 */
export const bundleServices = (options: HarnessOptions) => {
  // The host part installs its texts at `activate`; the envelope world does
  // so before anything reads a template or a built-in agent (S68d).
  installBundleAssets();
  const configuration = options.configuration ?? testConfiguration();
  const resolved: unknown[] = [];
  /** Every `models/v1.inputModalities` request, in order. */
  const modalities: unknown[] = [];
  /** Every entry the fake `log/v1` received, in order. */
  const logs: LoggedEntry[] = [];
  const languageModel = toLanguageModel(options.provider);
  /**
   * Every call the fake `runtime.lease/v1`, `default.skill-sources/v1`
   * (every source together) and `runtime.workspace/v1` received.
   */
  const calls = {
    lease: [] as RecordedCall[],
    sources: [] as RecordedCall[],
    workspace: [] as RecordedCall[],
  };
  const harness = createTestServices({
    bundle: { id: 'default' },
    providers: Object.entries(options.sources ?? {}).map(
      ([bundleId, source]) => ({
        bundleId,
        provide: [skillSourceService(source, calls.sources)],
      }),
    ),
    provide: [
      transformHooks(),
      logService(logs),
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
        inputModalities: defineMethod({
          input: modelsMethods.inputModalities.input,
          output: modelsMethods.inputModalities.output,
          execute: (request) => {
            modalities.push(request);
            return options.inputModalities;
          },
        }),
        icons: defineMethod({
          input: modelsMethods.icons.input,
          output: modelsMethods.icons.output,
          execute: ({ requests }) => ({
            svgs: {},
            answers: requests.map(({ models }) => ({
              models: models.map(() => null),
            })),
          }),
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
      skillsService(options.skills ?? []),
      ...(options.lease === undefined
        ? []
        : [leaseService(options.lease, calls.lease)]),
      ...(options.workspace === undefined
        ? []
        : [workspaceService(options.workspace, calls.workspace)]),
    ],
  });

  return {
    harness,
    resolved,
    modalities,
    calls,
    logs,
    activate: () =>
      provideEnvelope(harness.services, {
        now: options.now ?? (() => new Date(harnessNow)),
        builtInAgents: options.builtInAgents ?? [],
      }),
    executor: (scope: CallScope) => harness.services.use(ExecutorV1, scope),
  };
};

export const thread = (): ExecutorThread => ({
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
  services: ReturnType<typeof bundleServices>,
  state: ReturnType<typeof fakeThreadState>,
  prompt: string,
  {
    signal = new AbortController().signal,
    source = { kind: 'user' },
    id = promptId,
    cwdRepo,
    thread: overrides,
  }: {
    readonly signal?: AbortSignal;
    readonly source?: InputSource;
    readonly id?: string;
    /** The repository hint of the Thread snapshot the run receives. */
    readonly cwdRepo?: CwdRepo;
    /** Fields of the Thread snapshot the run receives (its agent, model, effort). */
    readonly thread?: Partial<ExecutorThread>;
  } = {},
): Promise<string> => {
  const result = await services
    .executor({ projectId, threadId, promptId: id })
    .run(
      {
        thread: {
          ...thread(),
          ...(cwdRepo === undefined ? {} : { cwdRepo }),
          ...overrides,
        },
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
    /** The retained messages' indexes by `<bundleId>:<reason>`. */
    readonly retained?: Readonly<Record<string, number>>;
  },
): void => {
  const messages = value.messages ?? [];
  state.apply({
    format: 'default.history/v1',
    parts: {
      messages,
      meta: {
        checkpoints: value.checkpoints ?? {},
        messageCount: messages.length,
        ...(value.retained === undefined ? {} : { retained: value.retained }),
      },
    },
  });
};
