// The harness the registry's tests run against: the bundle's own `activate`
// over `createTestServices`, with a fake Thread log behind two boundaries the
// registry reaches — `events/v1`, whose `append` writes a row into the log of
// the call's Thread, and `runtime.threads/v1`, whose `threadEvents` and
// `projectThreads` read that log back. The log outlives a harness, so a test
// can activate the bundle again over what an earlier activation wrote.

import {
  type AnyServiceDefinition,
  type Call,
  type CallScope,
  ContractError,
  type ContractTool,
  type Disposable,
  defineMethod,
  defineService,
  type EventDefinition,
  EventsV1,
  eventsMethods,
  type ToolRegistrationOptions,
  ToolsV1,
  toolsMethods,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  RuntimeThreadsV1,
  runtimeThreadsMethods,
  type ThreadEvent,
} from 'runtime/contracts';
import { isBoundTool, type Tool } from 'tool';

import {
  type Comments,
  CommentsV1,
  type CommentTarget,
} from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';

export type { CommentTarget };

const inert: Disposable = { dispose: () => undefined };

/** The durable Thread logs, as the runtime's storage keeps them. */
export interface ThreadLog {
  /** Every row, in append order, across every Thread. */
  readonly rows: ThreadEvent[];
  /** When set, the next appends fail as an unreachable store would. */
  failAppends: boolean;
}

export const threadLog = (): ThreadLog => ({ rows: [], failAppends: false });

/** `events/v1` for a test: an append writes one row into the call's Thread. */
const fakeEvents = (log: ThreadLog): AnyServiceDefinition =>
  defineService(EventsV1.id, {
    register: defineMethod({
      ...eventsMethods.register,
      execute: () => inert,
    }),
    sink: defineMethod({ ...eventsMethods.sink, execute: () => inert }),
    append: defineMethod({
      ...eventsMethods.append,
      execute: async (
        [event, payload]: readonly [EventDefinition, Record<string, unknown>],
        call: Call,
      ) => {
        if (log.failAppends) {
          throw new ContractError('unavailable', 'The store is unreachable.');
        }

        const { projectId, threadId, promptId } = call.scope ?? {};

        if (
          projectId === undefined ||
          threadId === undefined ||
          promptId === undefined
        ) {
          throw new ContractError('invalid_scope', 'The row needs a scope.');
        }

        const parsed = event.payload.parse(payload) as Record<string, unknown>;

        log.rows.push({
          projectId,
          threadId,
          promptId,
          sequence:
            log.rows.filter((row) => row.threadId === threadId).length + 1,
          type: event.type,
          event: { type: event.type, ...parsed },
          createdAt: new Date().toISOString(),
        });
      },
    }),
  });

/** `runtime.threads/v1` for a test: the two reads of the Thread log. */
const fakeThreads = (log: ThreadLog): AnyServiceDefinition =>
  defineService(RuntimeThreadsV1.id, {
    threadEvents: defineMethod({
      ...runtimeThreadsMethods.threadEvents,
      execute: async ({ id, afterSequence }) => {
        const events = log.rows.filter(
          (row) => row.threadId === id && row.sequence > afterSequence,
        );

        return {
          events,
          lastSequence: log.rows.filter((row) => row.threadId === id).length,
        };
      },
    }),
    projectThreads: defineMethod({
      ...runtimeThreadsMethods.projectThreads,
      execute: async (projectId: string) =>
        [
          ...new Set(
            log.rows
              .filter((row) => row.projectId === projectId)
              .map((row) => row.threadId),
          ),
        ].map((id) => ({
          id,
          projectId,
          name: id,
          state: 'ready' as const,
          lastSequence: 0,
          cwd: '/workspace',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
    }),
  });

/** One `tools/v1.register` call the fake registry received. */
export interface Registration {
  readonly tool: ContractTool;
  readonly options: ToolRegistrationOptions;
}

/** A recording `tools/v1`, standing for the core's registry. */
const fakeTools = (registered: Registration[]): AnyServiceDefinition =>
  defineService(ToolsV1, {
    register: defineMethod({
      input: toolsMethods.register.input,
      output: toolsMethods.register.output,
      execute: ([tool, options]) => {
        registered.push({ tool, options });

        return inert;
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
  });

export interface CommentsHarness {
  /** The Thread log the registry writes into and reads from. */
  readonly log: ThreadLog;
  /** A hop call into the bundle, scoped as a prompt's call is. */
  readonly call: (scope?: CallScope) => Call;
  readonly comments: Comments;
  /** What the bundle registered in `tools/v1`. */
  readonly registered: readonly Registration[];
  /** A registered tool, as the agent loop sees it for one prompt call. */
  readonly tool: (name: string, scope?: CallScope) => Tool;
  close(): Promise<void>;
}

/** The prompt scope every registry call in these tests runs under. */
export const promptScope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
  promptId: 'prompt-1',
};

/** Activates the bundle over `log` — a fresh one unless a test passes its own. */
export const commentsHarness = async (
  log: ThreadLog = threadLog(),
): Promise<CommentsHarness> => {
  const registered: Registration[] = [];
  const harness = createTestServices({
    bundle: { id: 'comments' },
    provide: [fakeEvents(log), fakeThreads(log), fakeTools(registered)],
  });

  await activate({ services: harness.services });

  return {
    log,
    call: (scope: CallScope = promptScope) => harness.call(scope),
    comments: harness.services.use(CommentsV1),
    registered,
    tool: (name: string, scope: CallScope = promptScope) => {
      const entry = registered.find(
        (candidate) => candidate.tool.name === name,
      );

      if (entry === undefined || !isBoundTool(entry.tool)) {
        throw new TypeError(`tools/v1 received no bound tool named ${name}`);
      }

      return entry.tool.toTool(harness.call(scope));
    },
    close: async () => {
      await harness.dispose();
    },
  } satisfies CommentsHarness;
};

/** The rows of one durable type the log holds, in order. */
export const rowsOf = (log: ThreadLog, type: string): ThreadEvent[] =>
  log.rows.filter((row) => row.type === type);
