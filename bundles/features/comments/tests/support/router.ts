// The harness of `comments`' host part through the router (phase 3, S52a):
// `comments/v1` and the `comment_reply` tool served by `createTestRouter` as
// `src/host/main.ts` serves them (`createCommentsHost`, its `activate`), with
// recording fakes of `events/v1` (`Register`, `Unregister`, `Sink`, `Append`),
// `runtime.threads/v1` (`ThreadEvents`, `ProjectThreads`) and `tools/v1`
// (`Register`, `Unregister`). Each fake records its request and
// `callOf(context).scope`.
//
// The Thread log is the kernel harness's `ThreadLog`, so a test can run the
// kernel and the router over the same rows. An appended row is stored as
// `core` stores it: `{type, ...toJson(unpacked)}` with fields at their default
// left out (finding F1), plus the envelope.

import type { DescService, JsonObject, JsonValue } from '@bufbuild/protobuf';
import { create, fromJson, toJson } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import {
  type Caller,
  type CallScope,
  type ContractError,
  callOf,
} from 'bundle/contracts';
import {
  RegisterRequestSchema as EventRegisterRequestSchema,
  EventsService,
  SinkRequestSchema,
} from 'bundle/contracts/gen/doric/events/v1/events_pb.js';
import {
  ToolHandlerService,
  RegisterRequestSchema as ToolRegisterRequestSchema,
  ToolsService,
} from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  ThreadEventLogSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import {
  ThreadEventSchema,
  ThreadSchema,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { CommentsAddedSchema } from '../../src/contracts/gen/doric/comments/added/v1/added_pb.js';
import { CommentsResolvedSchema } from '../../src/contracts/gen/doric/comments/resolved/v1/resolved_pb.js';
import { CommentsService } from '../../src/contracts/gen/doric/comments/v1/comments_pb.js';
import { createCommentsHost } from '../../src/host/service.js';
import { promptScope, type ThreadLog, threadLog } from './harness.js';

export { promptScope, type ThreadLog, threadLog };

/** `core`, as the router stamps it on its calls to the handler service. */
export const core: Caller = {
  bundleId: 'core',
  version: '1.0.0',
  generation: 1,
};

/** The services `comments`' host part declares it calls (section D). */
export const REQUIRES = [
  EventsService.typeName,
  ThreadsService.typeName,
  ToolsService.typeName,
];

/** One request a fake received, with the scope it carried. */
export interface Recorded<T> {
  readonly request: T;
  readonly scope: CallScope | undefined;
}

/** One `events/v1.Append` as the fake received it: the type and the unpacked message's JSON. */
export interface AppendRecord {
  readonly type: string;
  /** `toJson` of the unpacked message, fields at their default left out. */
  readonly payload: JsonObject;
}

/** Failures the fakes answer while set; a test sets and clears them. */
export interface Failures {
  /** `events/v1.Register` of this event type fails with the error. */
  registerEvent?: { readonly type: string; readonly error: ContractError };
  /** `tools/v1.Register` fails with the error. */
  registerTool?: ContractError;
  /** `events/v1.Append` fails with the error, writing nothing. */
  append?: ContractError;
  /** `runtime.threads/v1.ThreadEvents` fails with the error. */
  threadEvents?: ContractError;
  /** `runtime.threads/v1.ProjectThreads` fails with the error. */
  projectThreads?: ContractError;
}

export interface Harness {
  readonly router: TestRouter;
  /** The Thread log the fakes write into and read from. */
  readonly log: ThreadLog;
  /** What the fakes answer while set. */
  readonly failures: Failures;
  /**
   * While `pageSize` is set, `runtime.threads/v1.ThreadEvents` cuts every page
   * to that many events and keeps the log's `lastSequence` (the 1.10.0 cut).
   */
  readonly paging: { pageSize?: number };
  /**
   * Every call the fakes received, in order: `events.register:<type>`,
   * `events.sink`, `events.append:<type>`, `tools.register:<name>`,
   * `threads.threadEvents:<id>`, `threads.projectThreads:<projectId>`.
   */
  readonly timeline: string[];
  /** `events/v1.Register` requests, as JSON. */
  readonly eventRegisters: Recorded<JsonValue>[];
  /** `events/v1.Sink` requests, as JSON. */
  readonly sinks: Recorded<JsonValue>[];
  /** `events/v1.Append` requests that wrote a row. */
  readonly appends: Recorded<AppendRecord>[];
  /** `tools/v1.Register` requests, as JSON. */
  readonly toolRegisters: Recorded<JsonValue>[];
  /** `runtime.threads/v1.ThreadEvents` ids. */
  readonly threadEvents: Recorded<string>[];
  /** `runtime.threads/v1.ProjectThreads` project ids. */
  readonly projectThreads: Recorded<string>[];
  /** A client of the bundle's `comments/v1` with this scope (default {@link promptScope}). */
  comments(scope?: CallScope): Client<typeof CommentsService>;
  /** A client of the bundle's `comments/v1` whose calls carry no scope. */
  unscoped(): Client<typeof CommentsService>;
  /** `core`'s client of the bundle's `ToolHandlerService`, relaying a call of this scope. */
  tools(scope?: CallScope): Client<typeof ToolHandlerService>;
  /** Activates the part as `main.ts` does; rejects with what `activate` threw. */
  activate(): Promise<void>;
  /** Serves the part's services without running its `activate`. */
  serveWithoutActivate(): Promise<void>;
}

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/** The JSON of an unpacked `Append` payload, as `core` stores it today. */
const storedJson = (
  type: string,
  payload: Parameters<typeof anyUnpack>[0],
): JsonObject => {
  if (type === 'comments.added/v1') {
    const message = anyUnpack(payload, CommentsAddedSchema);

    if (message === undefined) throw new Error(`Not a ${type} payload.`);

    return toJson(CommentsAddedSchema, message) as JsonObject;
  }

  if (type === 'comments.resolved/v1') {
    const message = anyUnpack(payload, CommentsResolvedSchema);

    if (message === undefined) throw new Error(`Not a ${type} payload.`);

    return toJson(CommentsResolvedSchema, message) as JsonObject;
  }

  throw new Error(`Unexpected event type ${type}.`);
};

const timestamp = '2026-01-01T00:00:00.000Z';

/** `comments`' host part on a test router over `log`, not yet activated. */
export const harness = (log: ThreadLog = threadLog()): Harness => {
  const host = createCommentsHost();
  const failures: Failures = {};
  const paging: { pageSize?: number } = {};
  const timeline: string[] = [];
  const eventRegisters: Recorded<JsonValue>[] = [];
  const sinks: Recorded<JsonValue>[] = [];
  const appends: Recorded<AppendRecord>[] = [];
  const toolRegisters: Recorded<JsonValue>[] = [];
  const threadEvents: Recorded<string>[] = [];
  const projectThreads: Recorded<string>[] = [];
  let ids = 0;

  const router = createTestRouter({
    requires: REQUIRES,
    fakes: [
      fakeOf(EventsService, {
        register: (request, context) => {
          timeline.push(`events.register:${request.type}`);
          eventRegisters.push({
            request: toJson(EventRegisterRequestSchema, request),
            scope: callOf(context).scope,
          });

          if (failures.registerEvent?.type === request.type) {
            throw failures.registerEvent.error;
          }

          ids += 1;

          return { registrationId: `event-${ids}` };
        },
        unregister: () => ({}),
        sink: (request, context) => {
          timeline.push('events.sink');
          sinks.push({
            request: toJson(SinkRequestSchema, request),
            scope: callOf(context).scope,
          });

          return { registrationId: 'sink-1' };
        },
        unsink: () => ({}),
        append: (request, context) => {
          timeline.push(`events.append:${request.type}`);

          if (failures.append !== undefined) throw failures.append;

          const scope = callOf(context).scope;
          const { projectId, threadId, promptId } = scope ?? {};

          if (
            projectId === undefined ||
            threadId === undefined ||
            promptId === undefined ||
            request.payload === undefined
          ) {
            throw new Error('Append needs a prompt scope and a payload.');
          }

          const payload = storedJson(request.type, request.payload);

          appends.push({ request: { type: request.type, payload }, scope });
          log.rows.push({
            projectId,
            threadId,
            promptId,
            sequence:
              log.rows.filter((row) => row.threadId === threadId).length + 1,
            type: request.type,
            event: { type: request.type, ...payload },
            createdAt: new Date().toISOString(),
          });

          return {};
        },
      }),
      fakeOf(ThreadsService, {
        threadEvents: (request, context) => {
          timeline.push(`threads.threadEvents:${request.id}`);
          threadEvents.push({
            request: request.id,
            scope: callOf(context).scope,
          });

          if (failures.threadEvents !== undefined) throw failures.threadEvents;

          const rows = log.rows.filter((row) => row.threadId === request.id);

          if (rows.length === 0) return {};

          const after = rows.filter(
            (row) => row.sequence > request.afterSequence,
          );

          return {
            threadEventLog: create(ThreadEventLogSchema, {
              events: after
                .slice(0, paging.pageSize ?? after.length)
                .map((row) =>
                  fromJson(ThreadEventSchema, row as unknown as JsonValue),
                ),
              lastSequence: rows.length,
            }),
          };
        },
        projectThreads: (request, context) => {
          timeline.push(`threads.projectThreads:${request.projectId}`);
          projectThreads.push({
            request: request.projectId,
            scope: callOf(context).scope,
          });

          if (failures.projectThreads !== undefined) {
            throw failures.projectThreads;
          }

          return {
            threads: [
              ...new Set(
                log.rows
                  .filter((row) => row.projectId === request.projectId)
                  .map((row) => row.threadId),
              ),
            ].map((id) =>
              create(ThreadSchema, {
                id,
                projectId: request.projectId,
                name: id,
                state: 'ready',
                lastSequence: 0,
                cwd: '/workspace',
                createdAt: timestamp,
                updatedAt: timestamp,
              }),
            ),
          };
        },
      }),
      fakeOf(ToolsService, {
        register: (request, context) => {
          timeline.push(`tools.register:${request.tool?.name ?? ''}`);
          toolRegisters.push({
            request: toJson(ToolRegisterRequestSchema, request),
            scope: callOf(context).scope,
          });

          if (failures.registerTool !== undefined) throw failures.registerTool;

          ids += 1;

          return { registrationId: `tool-${ids}` };
        },
        unregister: () => ({}),
      }),
    ],
  });

  const services = () =>
    [
      [CommentsService, host.comments],
      [ToolHandlerService, host.tools.implementation],
    ] as const;

  return {
    router,
    log,
    failures,
    paging,
    timeline,
    eventRegisters,
    sinks,
    appends,
    toolRegisters,
    threadEvents,
    projectThreads,
    comments: (scope: CallScope = promptScope) =>
      router.client(CommentsService, { scope }),
    unscoped: () => router.client(CommentsService),
    tools: (scope: CallScope = promptScope) =>
      router.client(ToolHandlerService, { caller: core, scope }),
    activate: async () => {
      await router.activate({
        services: services(),
        activate: (context) => host.activate(context),
      });
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: services(),
        activate: () => undefined,
      });
    },
  };
};
