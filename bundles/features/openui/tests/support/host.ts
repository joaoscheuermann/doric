// One activation of the `openui` host over fakes of the services it requires:
// `runtime.threads/v1` (a Thread table, a log with the runtime's rewind rule,
// and the route's methods), `runtime.hooks/v1` through a recording `hooks/v1`,
// `events/v1` (appends become rows of the fake log) and `skills/v1` (a
// recording registry).
// The bundle's own contracts are reached through its services, with the scope
// a window's call carries.

import {
  type Activate,
  type AnyServiceDefinition,
  type Call,
  type CallScope,
  type Disposable,
  defineMethod,
  defineService,
  EventsV1,
  eventsMethods,
  type HooksContract,
  HooksV1,
  hooksMethods,
  type RegisteredSkill,
  type SkillSchemaInput,
  SkillsV1,
  skillsMethods,
} from 'bundle/contracts';
import { createTestServices, type TestServices } from 'bundle/testing';
import {
  RuntimeThreadsV1,
  runtimeThreadsMethods,
  type Thread,
  type ThreadEvent,
  type ThreadQueue,
} from 'runtime/contracts';

/** The host entry, imported by URL: `src/host/index.ts` is the module under test. */
const HOST_ENTRY = new URL('../../src/host/index.js', import.meta.url).href;

export const projectId = 'project-1';
export const otherProjectId = 'project-2';

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
          // Synchronous: `register`, `subscribe` and the like answer a Disposable at once.
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

/** A Thread record of the fake table. */
export const threadRecord = (
  id: string,
  options: {
    readonly projectId?: string;
    readonly origin?: 'user' | 'agent';
    readonly activePromptId?: string;
  } = {},
): Thread => ({
  id,
  projectId: options.projectId ?? projectId,
  name: `Thread ${id}`,
  state: options.activePromptId === undefined ? 'ready' : 'running',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...(options.origin === undefined ? {} : { origin: options.origin }),
  ...(options.activePromptId === undefined
    ? {}
    : { activePromptId: options.activePromptId }),
});

/** A queue of the fake runtime: `paused`, with nothing in it unless given. */
export const queueOf = (
  options: {
    readonly paused?: boolean;
    readonly resumable?: boolean;
    readonly items?: number;
  } = {},
): ThreadQueue => {
  const item = (promptId: string) => ({
    promptId,
    source: { kind: 'user' as const },
    label: 'You',
    preview: 'queued',
    acceptedAt: '2026-01-01T00:00:00.000Z',
    editable: true,
    revision: 1,
  });

  return {
    revision: 1,
    paused: options.paused ?? false,
    stopping: false,
    ...(options.resumable === true ? { resumable: item('resumable-1') } : {}),
    items: Array.from({ length: options.items ?? 0 }, (_, index) =>
      item(`queued-${index + 1}`),
    ),
  };
};

/** One call the fakes received: `runtime.threads/v1.<method>` or `events/v1.append`. */
export interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
  readonly call: Call;
}

/** The parts of `runtime.threads/v1` a test can answer; each defaults to the fake's own. */
export interface RuntimeAnswers {
  thread?: (id: string) => Promise<Thread | undefined> | Thread | undefined;
  steer?: (input: {
    readonly id: string;
    readonly prompt: string;
    readonly promptId: string;
  }) => unknown;
  prompt?: (input: { readonly id: string; readonly prompt: string }) => unknown;
  queue?: (id: string) => unknown;
  resumeQueue?: (id: string) => unknown;
  threadEvents?: (input: {
    readonly id: string;
    readonly afterSequence: number;
  }) => unknown;
  instruct?: (input: unknown) => unknown;
  /** `events/v1.append`: runs before the row is written; a throw rejects the append. */
  append?: (input: {
    readonly type: string;
    readonly payload: unknown;
  }) => void;
}

export interface HostWorld {
  readonly test: TestServices;
  /** The Threads `thread` answers, by id. */
  readonly threads: Map<string, Thread>;
  /** The Threads' queues, by id (default: running, nothing in it). */
  readonly queues: Map<string, ThreadQueue>;
  /** The fake log, every Thread's rows in append order. */
  readonly log: ThreadEvent[];
  /** Overrides of the fake runtime's answers. */
  readonly answers: RuntimeAnswers;
  /** Every `runtime.threads/v1` and `events/v1.append` call, in order. */
  readonly calls: RecordedCall[];
  /** The `instruct` inputs, each with whether a hook was running then. */
  readonly instructs: {
    readonly input: {
      readonly id: string;
      readonly prompt: string;
      readonly reason: string;
      readonly promptId?: string;
      readonly retain?: boolean;
    };
    readonly inHook: boolean;
  }[];
  /** The event types `events/v1.register` received. */
  readonly registeredEvents: string[];
  /** Every `skills/v1.register` call, with whether it was disposed since. */
  readonly skills: {
    readonly skill: SkillSchemaInput;
    readonly options?: {
      readonly alwaysAvailable?: boolean;
      readonly order?: number;
    };
    disposed: boolean;
  }[];
  /** Fires `runtime.hooks/v1.onPromptStartedHook` for a prompt of a Thread and awaits its handlers. */
  promptStarted(threadId: string, promptId: string): Promise<void>;
  /** Removes every row from the first row of `promptId` on, as the runtime's rewind does. */
  rewind(threadId: string, promptId: string): void;
  /** Appends a row to the log, as a prompt's own events would. */
  row(threadId: string, promptId: string, type: string, payload?: object): void;
  /** A hop Call with a scope. */
  call(scope?: CallScope): Call;
  /** Runs the bundle's cleanup, as the platform would. */
  deactivate(): Promise<void>;
}

/**
 * Activates the `openui` host over the fakes. The world takes no option; one
 * an older test passes is ignored, as no fake would read it.
 */
export const activateHost = async (
  _options: Readonly<Record<string, unknown>> = {},
): Promise<HostWorld> => {
  const threads = new Map<string, Thread>();
  const queues = new Map<string, ThreadQueue>();
  const log: ThreadEvent[] = [];
  const answers: RuntimeAnswers = {};
  const calls: RecordedCall[] = [];
  const instructs: HostWorld['instructs'] = [];
  const registeredEvents: string[] = [];
  const skills: HostWorld['skills'] = [];
  const hookHandlers: { hook: string; handler: Handler }[] = [];
  let inHook = 0;
  let sequence = 0;

  const row = (
    threadId: string,
    promptId: string,
    type: string,
    payload: object = {},
  ): void => {
    const thread = threads.get(threadId);
    sequence += 1;
    log.push({
      projectId: thread?.projectId ?? projectId,
      threadId,
      promptId,
      sequence,
      type,
      event: { type, ...payload },
      createdAt: new Date(sequence * 1000).toISOString(),
    });
  };

  const record = (method: string, input: unknown, call: Call): void => {
    calls.push({ method, input, call });
  };

  const runtime = fake(RuntimeThreadsV1.id, runtimeThreadsMethods, {
    thread: async (id: string, call) => {
      record('thread', id, call);
      return answers.thread === undefined
        ? threads.get(id)
        : await answers.thread(id);
    },
    steer: async (
      input: { id: string; prompt: string; promptId: string },
      call,
    ) => {
      record('steer', input, call);
      return answers.steer === undefined
        ? { status: 'steered', promptId: input.promptId }
        : await answers.steer(input);
    },
    prompt: async (input: { id: string; prompt: string }, call) => {
      record('prompt', input, call);
      return answers.prompt === undefined
        ? { status: 'accepted', promptId: 'answer-prompt' }
        : await answers.prompt(input);
    },
    queue: async (id: string, call) => {
      record('queue', id, call);
      return answers.queue === undefined
        ? (queues.get(id) ?? (threads.has(id) ? queueOf() : undefined))
        : await answers.queue(id);
    },
    resumeQueue: async (id: string, call) => {
      record('resumeQueue', id, call);
      if (answers.resumeQueue !== undefined)
        return await answers.resumeQueue(id);
      const thread = threads.get(id);
      return thread === undefined
        ? { status: 'missing' }
        : { status: 'resumed', thread };
    },
    threadEvents: async (
      input: { id: string; afterSequence: number },
      call,
    ) => {
      record('threadEvents', input, call);
      if (answers.threadEvents !== undefined)
        return await answers.threadEvents(input);
      const events = log.filter(
        (entry) =>
          entry.threadId === input.id && entry.sequence > input.afterSequence,
      );
      return { events, lastSequence: sequence };
    },
    instruct: async (input: HostWorld['instructs'][number]['input'], call) => {
      record('instruct', input, call);
      instructs.push({ input, inHook: inHook > 0 });
      return answers.instruct === undefined
        ? { status: 'steered', promptId: input.promptId ?? 'running' }
        : await answers.instruct(input);
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
    // runtime.hooks/v1 is defined: a waiter runs at once.
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
      answers.append?.({ type: definition.type, payload });
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

  const skillRegistry = fake(SkillsV1.id, skillsMethods, {
    register: ([skill, options]: [
      SkillSchemaInput,
      { alwaysAvailable?: boolean; order?: number } | undefined,
    ]) => {
      const entry: HostWorld['skills'][number] = {
        skill,
        ...(options === undefined ? {} : { options }),
        disposed: false,
      };
      skills.push(entry);
      return once(() => {
        entry.disposed = true;
      });
    },
    list: (): RegisteredSkill[] => [],
  });

  const test = createTestServices({
    bundle: { id: 'openui' },
    provide: [runtime, hooks, events, skillRegistry],
  });

  const { activate } = (await import(HOST_ENTRY)) as {
    readonly activate: Activate;
  };
  const cleanup = await activate({ services: test.services });
  let deactivated = false;

  return {
    test,
    threads,
    queues,
    log,
    answers,
    calls,
    instructs,
    registeredEvents,
    skills,
    promptStarted: async (threadId, promptId) => {
      const thread = threads.get(threadId);
      const input = {
        projectId: thread?.projectId ?? projectId,
        threadId,
        promptId,
        source: { kind: 'user' as const },
        cwd: '/workspace',
      };
      const call = test.call({
        projectId: input.projectId,
        threadId,
        promptId,
      });
      inHook += 1;
      try {
        await Promise.all(
          hookHandlers
            .filter(
              (entry) => entry.hook === 'runtime.hooks/v1#onPromptStartedHook',
            )
            .map(async (entry) => {
              await entry.handler(input as never, call);
            }),
        );
      } finally {
        inHook -= 1;
      }
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
    },
    row,
    call: (scope) => test.call(scope),
    deactivate: async () => {
      if (deactivated) return;
      deactivated = true;
      if (typeof cleanup === 'function') await cleanup();
      await test.dispose();
    },
  };
};

/** Lets every pending promise and the next macrotask run. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
