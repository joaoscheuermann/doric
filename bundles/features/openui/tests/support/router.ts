// The harness of `openui`'s host part through the router (phase 3, S56):
// `openui.programs/v1`, `openui.questions/v1` and the `onPromptStartedHook`
// handler served by `createTestRouter` as `src/host/main.ts` serves them
// (`createOpenuiHost`, its `activate`), with recording fakes of section D's
// services: `runtime.threads/v1` (`ThreadEvents`, `Thread`, `Steer`, `Queue`,
// `ResumeQueue`, `Prompt`, `Instruct`, over a Thread table and an in-memory
// log), `hooks/v1` (`Register`), `events/v1` (`Register`, `Append`, which
// writes the row as `core` stores it: `{type, ...toJson(…, {alwaysEmitImplicit:
// true})}`) and `skills/v1` (`Register`). Each fake records its request,
// `callOf(context).scope`, its deadline and whether its signal was aborted.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  create,
  type DescService,
  fromJson,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import { anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import type { Client, HandlerContext, ServiceImpl } from '@connectrpc/connect';
import {
  type CallScope,
  type ContractError,
  callOf,
  deadlineOf,
} from 'bundle/contracts';
import {
  RegisterRequestSchema as EventRegisterRequestSchema,
  EventsService,
} from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import {
  HookHandlerService,
  RegisterRequestSchema as HookRegisterRequestSchema,
  HooksService,
} from 'bundle/contracts/gen/doric/hooks/v1/hooks_pb.js';
import {
  RegisterRequestSchema as SkillRegisterRequestSchema,
  SkillsService,
} from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import { OnPromptStartedHookInputSchema } from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import {
  ThreadEventLogSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  ThreadEventSchema,
  ThreadSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { OpenuiAnsweredSchema } from '../../src/contracts/gen/doric/openui/answered/v1/answered_pb.js';
import { ProgramsService } from '../../src/contracts/gen/doric/openui/programs/v1/programs_pb.js';
import { QuestionsService } from '../../src/contracts/gen/doric/openui/questions/v1/questions_pb.js';
import { createOpenuiHost, type OpenuiHost } from '../../src/host/service.js';
import {
  core,
  type InputSourceInit,
  projectId,
  threadId,
  USER,
  windowScope,
} from './router-fixtures.js';

export * from './router-fixtures.js';

/** The bundle directory: `dist-tests/tests/support` is three levels below it. */
export const bundleRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The services `openui`'s host part declares it calls (section D). */
export const REQUIRES: readonly string[] = [
  ThreadsService.typeName,
  HooksService.typeName,
  EventsService.typeName,
  SkillsService.typeName,
];

/** One call a fake received. */
export interface FakeCall {
  /** `threads.<method>` or `events.append`. */
  readonly method: string;
  /** The request as JSON, implicit fields included (`afterSequence: 0`), unset optional fields left out. */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
  /** `deadlineOf(callOf(context))`, 0 when none. */
  readonly deadline: number;
  /** Whether the call's signal was aborted when the fake received it. */
  readonly aborted: boolean;
}

/** A Thread as the fake `Thread` answers it. */
export interface FakeThread {
  readonly projectId: string;
  readonly origin?: 'user' | 'agent';
  readonly activePromptId?: string;
}

/** A stored row of the fake log, as `ThreadEvents` answers it (JSON). */
export interface StoredRow {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: JsonObject;
  readonly createdAt: string;
}

/** Failures the fakes answer while set; a test sets and clears them. */
export interface Failures {
  registerSkill?: ContractError;
  append?: ContractError;
}

export interface WorldOptions {
  /** `readAsset` given to `createOpenuiHost`; `'context'` gives none (the real `context.assets`). Default: reads the bundle's own file. */
  readonly readAsset?: ((path: string) => Promise<Uint8Array>) | 'context';
  /** `createTestRouter`'s `bundleDir`. */
  readonly bundleDir?: string;
}

export interface RouterWorld {
  readonly router: TestRouter;
  readonly host: OpenuiHost;
  readonly threads: Map<string, FakeThread>;
  /** Whether a Thread's queue is paused (default not); queues are always empty. */
  readonly paused: Map<string, boolean>;
  readonly log: StoredRow[];
  /** `runtime.threads/v1` calls and `events/v1.Append`s, in order. */
  readonly calls: FakeCall[];
  /** Registrations and calls in order: `events.register`, `hooks.register`, `skills.register`, `threads.<method>`, `events.append`. */
  readonly timeline: string[];
  readonly eventRegisters: JsonValue[];
  readonly hookRegisters: JsonValue[];
  readonly skillRegisters: JsonValue[];
  /** Paths `readAsset` was asked for. */
  readonly assetReads: string[];
  /** Answers replacing the fake `runtime.threads/v1`'s own, after the call was recorded. */
  readonly threadsAnswers: Partial<ServiceImpl<typeof ThreadsService>>;
  readonly failures: Failures;
  /** The recorded calls of one `threads.<method>` or `events.append`. */
  callsOf(method: string): FakeCall[];
  programs(scope?: CallScope): Client<typeof ProgramsService>;
  questions(scope?: CallScope): Client<typeof QuestionsService>;
  hooks(scope?: CallScope): Client<typeof HookHandlerService>;
  /** `core` relays `onPromptStartedHook` for a prompt of a Thread, in the prompt's scope. */
  promptStarted(
    threadId: string,
    promptId: string,
    source?: InputSourceInit,
  ): Promise<void>;
  /** Appends a row, as a prompt's own events or the kernel would. */
  row(
    threadId: string,
    promptId: string,
    type: string,
    event?: JsonObject,
  ): void;
  /** Removes every row of `threadId` from the first row of `promptId` on, as the runtime's rewind does. */
  rewind(threadId: string, promptId: string): void;
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
  /** Serves the part's services without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
  /** Stops the bundle (runs `deactivate`). */
  stop(): Promise<void>;
}

const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const timestamp = '2026-01-01T00:00:00.000Z';

/** Reads `path` from the bundle directory, as `context.assets.read` would after S62. */
const readOwnAsset = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(join(bundleRoot, path)));

/** `openui`'s host part on a test router, not yet activated; `thread-1` is known. */
export const routerWorld = (options: WorldOptions = {}): RouterWorld => {
  const assetReads: string[] = [];
  const reader = options.readAsset ?? readOwnAsset;
  const host = createOpenuiHost(
    reader === 'context'
      ? {}
      : {
          readAsset: (path) => {
            assetReads.push(path);
            return reader(path);
          },
        },
  );
  const threads = new Map<string, FakeThread>([[threadId, { projectId }]]);
  const paused = new Map<string, boolean>();
  const log: StoredRow[] = [];
  const calls: FakeCall[] = [];
  const timeline: string[] = [];
  const eventRegisters: JsonValue[] = [];
  const hookRegisters: JsonValue[] = [];
  const skillRegisters: JsonValue[] = [];
  const threadsAnswers: Partial<ServiceImpl<typeof ThreadsService>> = {};
  const failures: Failures = {};
  let ids = 0;

  const record = (
    method: string,
    request: JsonValue,
    context: HandlerContext,
  ): void => {
    const call = callOf(context);
    calls.push({
      method,
      request,
      scope: call.scope,
      deadline: deadlineOf(call),
      aborted: context.signal.aborted,
    });
    timeline.push(method);
  };

  const row = (
    rowThreadId: string,
    promptId: string,
    type: string,
    event: JsonObject = {},
  ): void => {
    log.push({
      projectId: threads.get(rowThreadId)?.projectId ?? projectId,
      threadId: rowThreadId,
      promptId,
      sequence: log.length + 1,
      type,
      event: { type, ...event },
      createdAt: timestamp,
    });
  };

  const threadMessage = (id: string, thread: FakeThread) =>
    create(ThreadSchema, {
      id,
      projectId: thread.projectId,
      name: id,
      state: thread.activePromptId === undefined ? 'ready' : 'running',
      lastSequence: 0,
      cwd: '/workspace',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(thread.origin === undefined ? {} : { origin: thread.origin }),
      ...(thread.activePromptId === undefined
        ? {}
        : { activePromptId: thread.activePromptId }),
    });

  /** Records the call, then answers with the test's answer or the fake's own. */
  const recorded = <M extends keyof ServiceImpl<typeof ThreadsService>>(
    method: M,
    own: ServiceImpl<typeof ThreadsService>[M],
  ) =>
    ((request: { readonly $typeName: string }, context: HandlerContext) => {
      const input = ThreadsService.method[method].input;
      record(
        `threads.${method}`,
        toJson(input, request as never, { alwaysEmitImplicit: true }),
        context,
      );
      const answer = (threadsAnswers[method] ?? own) as (
        request: unknown,
        context: HandlerContext,
      ) => unknown;
      return answer(request, context);
    }) as unknown as ServiceImpl<typeof ThreadsService>[M];

  const runtimeThreads = fakeOf(ThreadsService, {
    threadEvents: recorded('threadEvents', (request) => {
      const rows = log.filter((entry) => entry.threadId === request.id);
      if (rows.length === 0) return {};
      return {
        threadEventLog: create(ThreadEventLogSchema, {
          events: rows
            .filter((entry) => entry.sequence > request.afterSequence)
            .map((entry) =>
              fromJson(ThreadEventSchema, entry as unknown as JsonValue),
            ),
          lastSequence: log.length,
        }),
      };
    }),
    thread: recorded('thread', (request) => {
      const thread = threads.get(request.id);
      return thread === undefined
        ? {}
        : { thread: threadMessage(request.id, thread) };
    }),
    steer: recorded('steer', (request) => ({
      steerResult: { status: 'steered', promptId: request.promptId },
    })),
    queue: recorded('queue', (request) =>
      threads.has(request.id)
        ? {
            threadQueue: {
              revision: 1,
              paused: paused.get(request.id) ?? false,
              stopping: false,
              items: [],
            },
          }
        : {},
    ),
    resumeQueue: recorded('resumeQueue', (request) => {
      const thread = threads.get(request.id);
      return thread === undefined
        ? { resumeResult: { status: 'missing' } }
        : {
            resumeResult: {
              status: 'resumed',
              thread: threadMessage(request.id, thread),
            },
          };
    }),
    prompt: recorded('prompt', () => ({
      promptResult: { status: 'accepted', promptId: 'answer-prompt' },
    })),
    instruct: recorded('instruct', (request) => ({
      steerResult: {
        status: 'steered',
        promptId: request.promptId ?? 'running',
      },
    })),
  });

  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'openui' },
    ...(options.bundleDir === undefined
      ? {}
      : { bundleDir: options.bundleDir }),
    fakes: [
      runtimeThreads,
      fakeOf(HooksService, {
        register: (request) => {
          timeline.push('hooks.register');
          hookRegisters.push(toJson(HookRegisterRequestSchema, request));
          ids += 1;
          return { registrationId: `hook-${ids}` };
        },
        unregister: () => ({}),
      }),
      fakeOf(EventsService, {
        register: (request) => {
          timeline.push('events.register');
          eventRegisters.push(toJson(EventRegisterRequestSchema, request));
          ids += 1;
          return { registrationId: `event-${ids}` };
        },
        unregister: () => ({}),
        append: (request, context) => {
          const unpacked =
            request.payload === undefined
              ? undefined
              : anyUnpack(request.payload, OpenuiAnsweredSchema);
          const payload =
            unpacked === undefined
              ? {}
              : (toJson(OpenuiAnsweredSchema, unpacked, {
                  alwaysEmitImplicit: true,
                }) as JsonObject);
          record('events.append', { type: request.type, payload }, context);
          if (failures.append !== undefined) throw failures.append;
          const scope = callOf(context).scope ?? {};
          if (
            scope.projectId === undefined ||
            scope.threadId === undefined ||
            scope.promptId === undefined ||
            unpacked === undefined
          ) {
            throw new Error(
              'Append needs a prompt scope and an answered payload.',
            );
          }
          row(scope.threadId, scope.promptId, request.type, payload);
          return {};
        },
      }),
      fakeOf(SkillsService, {
        register: (request) => {
          timeline.push('skills.register');
          skillRegisters.push(toJson(SkillRegisterRequestSchema, request));
          if (failures.registerSkill !== undefined)
            throw failures.registerSkill;
          ids += 1;
          return { registrationId: `skill-${ids}` };
        },
        unregister: () => ({}),
      }),
    ],
  });

  const services = () =>
    [
      [ProgramsService, host.programs],
      [QuestionsService, host.questions],
      [HookHandlerService, host.hooks.implementation],
    ] as const;

  const hooks = (scope?: CallScope) =>
    router.client(HookHandlerService, {
      caller: core,
      ...(scope === undefined ? {} : { scope }),
    });

  return {
    router,
    host,
    threads,
    paused,
    log,
    calls,
    timeline,
    eventRegisters,
    hookRegisters,
    skillRegisters,
    assetReads,
    threadsAnswers,
    failures,
    callsOf: (method) => calls.filter((entry) => entry.method === method),
    programs: (scope = windowScope) =>
      router.client(ProgramsService, { scope }),
    questions: (scope = windowScope) =>
      router.client(QuestionsService, { scope }),
    hooks,
    promptStarted: async (startedThreadId, promptId, source = USER) => {
      const startedProjectId =
        threads.get(startedThreadId)?.projectId ?? projectId;
      await hooks({
        projectId: startedProjectId,
        threadId: startedThreadId,
        promptId,
      }).handle({
        contract: 'runtime.hooks/v1',
        hook: 'onPromptStartedHook',
        input: anyPack(
          OnPromptStartedHookInputSchema,
          create(OnPromptStartedHookInputSchema, {
            projectId: startedProjectId,
            threadId: startedThreadId,
            promptId,
            source,
            cwd: '/workspace',
          }),
        ),
      });
    },
    row,
    rewind: (rewoundThreadId, promptId) => {
      const first = log.findIndex(
        (entry) =>
          entry.threadId === rewoundThreadId && entry.promptId === promptId,
      );
      if (first < 0) return;
      const kept = log.filter(
        (entry, index) => index < first || entry.threadId !== rewoundThreadId,
      );
      log.splice(0, log.length, ...kept);
    },
    activate: async () => {
      await router.activate({
        services: services(),
        activate: (context) => host.activate(context),
        deactivate: () => host.deactivate(),
      });
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: services(),
        activate: () => undefined,
      });
    },
    stop: () => router.control.stop(),
  };
};
