// The services papercraft's host requires, as fakes behind `createTestServices`
// (after `bundles/features/openui/tests/support/host.ts`): `runtime.threads/v1`
// (a log with the runtime's rewind rule: the rows go and a
// `history.truncated` marker is appended), `runtime.hooks/v1` through a
// recording `hooks/v1`, `events/v1` (an append becomes a row of the log, and
// is refused without a prompt scope), `settings/v1` (one value per space,
// with live subscribers), `skills/v1` and `tools/v1` (recording registries;
// with `otherTools`, `skills/v1.register` applies the core's rule and raises
// `unavailable_tool` for an `allowedTools` entry no live tool has),
// `artifact.kind/v1`, `runtime.lease/v1` (no lease, or a given sandbox) and
// `files/v1` (a map of files, or none).
//
// A test uses the services directly (`createLibraryHooks`, `createPrograms`)
// or activates the real host entry over them (`activate`).

import {
  type Activate,
  type AnyServiceDefinition,
  AppHooksV1,
  type Call,
  type CallScope,
  ContractError,
  type Disposable,
  defineMethod,
  defineService,
  EventsV1,
  eventsMethods,
  type HooksContract,
  HooksV1,
  hooksMethods,
  type RegisteredSkill,
  type SettingsDefinition,
  type SettingsEntry,
  SettingsV1,
  type SkillSchemaInput,
  SkillsV1,
  settingsMethods,
  skillsMethods,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices, type TestServices } from 'bundle/testing';
import {
  RuntimeThreadsV1,
  runtimeThreadsMethods,
  type ThreadEvent,
} from 'runtime/contracts';
import { z } from 'zod';

import type { RunnerSandbox } from '../../src/host/sandbox.js';

/** The host entry, imported by URL: `src/host/index.ts` is the module under test. */
const HOST_ENTRY = new URL('../../src/host/index.js', import.meta.url).href;

/** The setting space papercraft follows (`openui.generative-ui/v1`). */
export const SETTING_ID = 'openui.generative-ui/v1';

export const projectId = 'project-1';

type Handler = (input: never, call: Call) => unknown;

const once = (dispose: () => void): Disposable => {
  let done = false;

  return {
    dispose: () => {
      if (done) return;
      done = true;
      dispose();
    },
  };
};

/** A provider whose every method answers through `handlers`, or throws when the test gave it none. */
const fake = (
  id: string,
  specs: Readonly<
    Record<string, { readonly input: unknown; readonly output: unknown }>
  >,
  handlers: Readonly<Record<string, Handler>>,
): AnyServiceDefinition =>
  defineService(
    id as `${string}/v${number}`,
    Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [
        name,
        defineMethod({
          input: spec.input as never,
          output: spec.output as never,
          execute: ((input: unknown, call: Call) => {
            const handler = handlers[name];

            if (handler === undefined) {
              throw new Error(`The test fakes no ${id}.${name}.`);
            }

            return handler(input as never, call);
          }) as never,
        }),
      ]),
    ),
  );

/** Specs with no check, for contracts papercraft consumes through structural copies. */
const loose = (
  ...names: string[]
): Record<string, { input: z.ZodType; output: z.ZodType }> =>
  Object.fromEntries(
    names.map((name) => [name, { input: z.any(), output: z.any() }]),
  );

export interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
  readonly call: Call;
}

export interface InstructInput {
  readonly id: string;
  readonly prompt: string;
  readonly reason: string;
  readonly promptId?: string;
  readonly retain?: boolean;
}

export interface WorldOptions {
  /** `openui.generative-ui/v1`'s `enabled` (default true). */
  readonly enabled?: boolean;
  /** The sandbox `runtime.lease/v1.withLease` hands its task; no lease when absent. */
  readonly sandbox?: RunnerSandbox;
  /** `files/v1` content by Project path; no `files/v1` read answers when absent. */
  readonly files?: Readonly<Record<string, string>>;
  /** Directories `files/v1.content` answers `not_file` for. */
  readonly directories?: readonly string[];
  /** `skills/v1.register` throws this error when given. */
  readonly skillError?: Error;
  /**
   * Tools other bundles register, live once every bundle has loaded (at
   * `hostStart`). When given, `skills/v1.register` checks every
   * `allowedTools` entry against the live tools, as the core's registry does.
   */
  readonly otherTools?: readonly string[];
}

/** One registration or disposal `tools/v1` or `skills/v1` saw, in order. */
export interface RegistryStep {
  readonly action: 'register' | 'dispose';
  readonly kind: 'tool' | 'skill';
  readonly name: string;
}

export interface World {
  readonly test: TestServices;
  readonly log: ThreadEvent[];
  readonly calls: RecordedCall[];
  readonly instructs: InstructInput[];
  readonly registeredEvents: string[];
  readonly skills: {
    readonly skill: SkillSchemaInput;
    readonly options?: {
      readonly alwaysAvailable?: boolean;
      readonly order?: number;
    };
    disposed: boolean;
  }[];
  readonly tools: string[];
  /** Every `tools/v1.register` call, with its options and whether it was disposed since. */
  readonly toolRegistrations: {
    readonly name: string;
    readonly options: unknown;
    disposed: boolean;
  }[];
  /** Every registration and disposal of `tools/v1` and `skills/v1`, in order. */
  readonly registry: RegistryStep[];
  /** The errors `skills/v1.register` raised. */
  readonly skillErrors: Error[];
  /** The tool names live now: `otherTools` once loaded, then this bundle's not disposed. */
  liveTools(): string[];
  /** `events/v1.append` runs this first; a throw rejects the append. */
  appendCheck: (input: {
    readonly type: string;
    readonly payload: unknown;
  }) => void;
  /** `runtime.threads/v1.instruct` runs this first; a throw rejects it. */
  instructCheck: (input: InstructInput) => void;
  writeSetting(enabled: boolean): void;
  /** Appends a row to the log, as a prompt's own events would. */
  row(
    threadId: string,
    promptId: string,
    type: string,
    payload?: object,
  ): ThreadEvent;
  /** `load_skill` with `{ name }`, started and finished, in `promptId`. */
  loadSkill(threadId: string, promptId: string, name?: string): void;
  /** Removes every row from the first row of `promptId` on and writes the marker row. */
  rewind(threadId: string, promptId: string): void;
  /** The `papercraft.cwd/v1` rows of a Thread, in order. */
  cwdRows(threadId: string): ThreadEvent[];
  /** The `threadEvents` and `storedEventsAfter` calls so far. */
  reads(): number;
  call(scope?: CallScope): Call;
  /**
   * Activates the real host entry over these services and fires its hooks;
   * `entry` names another copy of the compiled entry (PC17's, beside a runner).
   */
  activate(entry?: string): Promise<ActiveHost>;
  dispose(): Promise<void>;
}

export interface ActiveHost {
  /** Fires `doric.app.hooks/v1.onHostStartHook` once every bundle has loaded; `otherTools` go live first. */
  hostStart(): Promise<void>;
  promptStarted(input: {
    readonly threadId: string;
    readonly promptId: string;
    readonly cwd: string;
  }): Promise<void>;
  deactivate(): Promise<void>;
}

/** A hook input of `onPromptStartedHook`. */
export const promptStartedInput = (
  threadId: string,
  promptId: string,
  cwd: string,
) => ({
  projectId,
  threadId,
  promptId,
  source: { kind: 'user' as const },
  cwd,
});

/** A hook input of `onThreadCwdChangedHook`. */
export const cwdChangedInput = (
  threadId: string,
  cwd: string,
  previous: string,
  promptId?: string,
) => ({
  projectId,
  threadId,
  ...(promptId === undefined ? {} : { promptId }),
  cwd,
  previous: { cwd: previous },
});

/** Builds the fakes, and the services of a `papercraft` principal over them. */
export const world = (options: WorldOptions = {}): World => {
  const log: ThreadEvent[] = [];
  const calls: RecordedCall[] = [];
  const instructs: InstructInput[] = [];
  const registeredEvents: string[] = [];
  const skills: World['skills'] = [];
  const tools: string[] = [];
  const toolRegistrations: World['toolRegistrations'] = [];
  const registry: RegistryStep[] = [];
  const skillErrors: Error[] = [];
  let othersLoaded = false;
  const liveTools = (): string[] => [
    ...(othersLoaded ? (options.otherTools ?? []) : []),
    ...toolRegistrations
      .filter(({ disposed }) => !disposed)
      .map(({ name }) => name),
  ];
  const hookHandlers: { hook: string; handler: Handler }[] = [];
  const subscribers = new Set<(entry: SettingsEntry) => void>();
  let enabled = options.enabled ?? true;
  let revision = 0;
  let sequence = 0;

  const row = (
    threadId: string,
    promptId: string,
    type: string,
    payload: object = {},
  ): ThreadEvent => {
    sequence += 1;
    const entry: ThreadEvent = {
      projectId,
      threadId,
      promptId,
      sequence,
      type,
      event: { type, ...payload },
      createdAt: new Date(sequence * 1000).toISOString(),
    };
    log.push(entry);

    return entry;
  };

  const record = (method: string, input: unknown, call: Call): void => {
    calls.push({ method, input, call });
  };

  const settingEntry = (definition?: SettingsDefinition): SettingsEntry => ({
    value:
      definition === undefined
        ? { enabled }
        : definition.schema.parse(
            definition.id === SETTING_ID ? { enabled } : {},
          ),
    revision,
    version: '1.0.0',
    updatedAt: new Date(0).toISOString(),
    generation: revision,
  });

  const eventsAfter = (id: string, afterSequence: number) =>
    log.filter(
      (entry) => entry.threadId === id && entry.sequence > afterSequence,
    );

  const state = {
    appendCheck: (() => undefined) as World['appendCheck'],
    instructCheck: (() => undefined) as World['instructCheck'],
  };

  const runtime = fake(RuntimeThreadsV1.id, runtimeThreadsMethods, {
    thread: (id: string, call) => {
      record('thread', id, call);
      return {
        id,
        projectId,
        name: `Thread ${id}`,
        state: 'running',
        lastSequence: sequence,
        cwd: '/workspace',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    },
    threadEvents: (input: { id: string; afterSequence: number }, call) => {
      record('threadEvents', input, call);
      return {
        events: eventsAfter(input.id, input.afterSequence),
        lastSequence: sequence,
      };
    },
    storedEventsAfter: (input: { id: string; afterSequence: number }, call) => {
      record('storedEventsAfter', input, call);
      return eventsAfter(input.id, input.afterSequence);
    },
    instruct: (input: InstructInput, call) => {
      record('instruct', input, call);
      state.instructCheck(input);
      instructs.push(input);
      return { status: 'steered', promptId: input.promptId ?? 'running' };
    },
  });

  const hooks = fake(HooksV1.id, hooksMethods, {
    define: () => once(() => undefined),
    register: ([contract, hook, handler]: [HooksContract, string, Handler]) => {
      const entry = { hook: `${contract.id}#${hook}`, handler };
      hookHandlers.push(entry);
      return once(() => {
        hookHandlers.splice(hookHandlers.indexOf(entry), 1);
      });
    },
    whenDefined: ([, callback]: [HooksContract, () => unknown]) => {
      const cleanup = callback();
      return once(() => {
        if (typeof cleanup === 'function') void (cleanup as () => unknown)();
      });
    },
  });

  const events = fake(EventsV1.id, eventsMethods, {
    register: (definition: { type: string }) => {
      registeredEvents.push(definition.type);
      return once(() => undefined);
    },
    sink: () => once(() => undefined),
    append: (
      [definition, payload]: [{ type: string }, Record<string, unknown>],
      call,
    ) => {
      record('append', { type: definition.type, payload }, call);
      state.appendCheck({ type: definition.type, payload });
      const scope = call.scope ?? {};
      if (
        scope.projectId === undefined ||
        scope.threadId === undefined ||
        scope.promptId === undefined
      ) {
        throw new Error('events/v1.append needs a prompt scope.');
      }
      row(scope.threadId, scope.promptId, definition.type, payload);
    },
  });

  const settings = fake(SettingsV1.id, settingsMethods, {
    register: () => once(() => undefined),
    get: (definition: SettingsDefinition) => settingEntry(definition).value,
    entry: (definition: SettingsDefinition) => settingEntry(definition),
    set: ([definition, value]: [SettingsDefinition, { enabled?: boolean }]) => {
      enabled = value.enabled === true;
      revision += 1;
      return settingEntry(definition);
    },
    subscribe: ([, listener]: [
      SettingsDefinition,
      (entry: SettingsEntry) => void,
    ]) => {
      subscribers.add(listener);
      return once(() => {
        subscribers.delete(listener);
      });
    },
  });

  const skillRegistry = fake(SkillsV1.id, skillsMethods, {
    register: ([skill, registration]: [
      SkillSchemaInput,
      { alwaysAvailable?: boolean; order?: number } | undefined,
    ]) => {
      if (options.skillError !== undefined) throw options.skillError;
      if (options.otherTools !== undefined) {
        const live = new Set(liveTools());
        const missing = skill.allowedTools?.find((name) => !live.has(name));
        if (missing !== undefined) {
          const error = new ContractError(
            'unavailable_tool',
            `Skill "${skill.name}" references unavailable tool "${missing}".`,
          );
          skillErrors.push(error);
          throw error;
        }
      }
      const entry: World['skills'][number] = {
        skill,
        ...(registration === undefined ? {} : { options: registration }),
        disposed: false,
      };
      skills.push(entry);
      registry.push({ action: 'register', kind: 'skill', name: skill.name });
      return once(() => {
        entry.disposed = true;
        registry.push({ action: 'dispose', kind: 'skill', name: skill.name });
      });
    },
    list: (): RegisteredSkill[] =>
      skills
        .filter(({ disposed }) => !disposed)
        .map(({ skill }) => skill as unknown as RegisteredSkill),
  });

  const toolRegistry = fake('tools/v1', toolsMethods, {
    register: (input: unknown) => {
      const [tool, registration] = (Array.isArray(input) ? input : [input]) as [
        { readonly name?: string; readonly definition?: { name?: string } },
        unknown,
      ];
      const name = tool.name ?? tool.definition?.name ?? '';
      tools.push(name);
      const entry = { name, options: registration, disposed: false };
      toolRegistrations.push(entry);
      registry.push({ action: 'register', kind: 'tool', name });
      return once(() => {
        entry.disposed = true;
        registry.push({ action: 'dispose', kind: 'tool', name });
      });
    },
    list: () => [],
    catalog: () => [],
  });

  const kinds = fake('artifact.kind/v1', loose('register', 'list', 'get'), {
    register: () => once(() => undefined),
    list: () => [],
    get: () => undefined,
  });

  const lease = fake('runtime.lease/v1', loose('withLease'), {
    withLease: async (task: (sandbox: RunnerSandbox) => Promise<unknown>) =>
      options.sandbox === undefined
        ? { status: 'unavailable' }
        : { status: 'ready', value: await task(options.sandbox) },
  });

  const files = fake('files/v1', loose('content'), {
    content: (input: { path: string; encoding?: string }, call) => {
      record('files.content', input, call);
      if (options.files === undefined) return { status: 'unavailable' };
      const path = input.path.replace(/^\/+/u, '');
      if (options.directories?.includes(path)) {
        return { status: 'ready', value: { status: 'not_file' } };
      }
      const content = options.files[path];
      if (content === undefined) {
        return { status: 'ready', value: { status: 'not_found' } };
      }
      return {
        status: 'ready',
        value: {
          status: 'read',
          path,
          content:
            input.encoding === 'base64'
              ? Buffer.from(content).toString('base64')
              : content,
          truncated: false,
          binary: false,
        },
      };
    },
  });

  const test = createTestServices({
    bundle: { id: 'papercraft' },
    provide: [
      runtime,
      hooks,
      events,
      settings,
      skillRegistry,
      toolRegistry,
      kinds,
      lease,
      files,
    ],
  });

  const fire = async (hook: string, input: object, scope: CallScope) => {
    const call = test.call(scope);
    await Promise.all(
      hookHandlers
        .filter((entry) => entry.hook === `runtime.hooks/v1#${hook}`)
        .map(async (entry) => {
          await entry.handler(input as never, call);
        }),
    );
  };

  const self: World = {
    test,
    log,
    calls,
    instructs,
    registeredEvents,
    skills,
    tools,
    toolRegistrations,
    registry,
    skillErrors,
    liveTools,
    get appendCheck() {
      return state.appendCheck;
    },
    set appendCheck(check) {
      state.appendCheck = check;
    },
    get instructCheck() {
      return state.instructCheck;
    },
    set instructCheck(check) {
      state.instructCheck = check;
    },
    writeSetting: (value) => {
      enabled = value;
      revision += 1;
      for (const listener of [...subscribers]) listener(settingEntry());
    },
    row,
    loadSkill: (threadId, promptId, name = 'papercraft') => {
      const call = {
        id: `call-${String(sequence + 1)}`,
        name: 'load_skill',
        payload: { name },
      };
      row(threadId, promptId, 'tool.started', { call });
      row(threadId, promptId, 'tool.finished', {
        call,
        record: { output: { name } },
      });
    },
    rewind: (threadId, promptId) => {
      const first = log.findIndex(
        (entry) => entry.threadId === threadId && entry.promptId === promptId,
      );
      if (first < 0) return;
      const kept = log.filter(
        (entry, index) => entry.threadId !== threadId || index < first,
      );
      log.splice(0, log.length, ...kept);
      const afterSequence =
        kept.filter((entry) => entry.threadId === threadId).at(-1)?.sequence ??
        0;
      row(threadId, promptId, 'history.truncated', { afterSequence });
    },
    cwdRows: (threadId) =>
      log.filter(
        (entry) =>
          entry.threadId === threadId && entry.type === 'papercraft.cwd/v1',
      ),
    reads: () =>
      calls.filter(({ method }) =>
        ['threadEvents', 'storedEventsAfter'].includes(method),
      ).length,
    call: (scope) => test.call(scope),
    activate: async (entry = HOST_ENTRY) => {
      const { activate } = (await import(entry)) as {
        readonly activate: Activate;
      };
      const cleanup = await activate({ services: test.services });

      return {
        hostStart: async () => {
          othersLoaded = true;
          const call = test.call();
          for (const entry of hookHandlers.filter(
            ({ hook }) => hook === `${AppHooksV1.id}#onHostStartHook`,
          )) {
            await entry.handler({} as never, call);
          }
        },
        promptStarted: async ({ threadId, promptId, cwd }) => {
          await fire(
            'onPromptStartedHook',
            promptStartedInput(threadId, promptId, cwd),
            { projectId, threadId, promptId },
          );
        },
        deactivate: async () => {
          if (typeof cleanup === 'function') await cleanup();
        },
      };
    },
    dispose: () => test.dispose(),
  };

  return self;
};

/** Lets every pending promise and the next macrotask run. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Waits until `check` holds, or fails after `ms`. */
export const eventually = async (
  check: () => boolean,
  ms = 5_000,
): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('The condition never held.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
