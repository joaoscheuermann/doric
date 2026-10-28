// The harness the `ask` tests run against: the bundle's own `activate` over
// `createTestServices`, with a fake Thread log behind the boundaries `ask`
// reaches — `events/v1`, whose `append` writes a row into the log of the
// call's Thread, and `runtime.threads/v1`, whose `threadEvents` reads that log
// back, whose `thread` describes the one Thread under test, and whose `steer`
// records the input the answers become. The log outlives a harness, so a test
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
  type SteerResult,
  type Thread,
  type ThreadEvent,
} from 'runtime/contracts';
import { isBoundTool, type Tool } from 'tool';

import { type Ask, AskV1 } from '../../src/contracts/index.js';
import { activate } from '../../src/host/index.js';

const inert: Disposable = { dispose: () => undefined };

export const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1700';
/** The Thread every call in these tests belongs to. */
export const threadId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1701';
/** The prompt the `ask` tool runs under (P). */
export const askPromptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1702';
/** Another prompt, running when the answers arrive (Q). */
export const activePromptId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1703';

/** The prompt scope the tool and the service calls run under. */
export const promptScope: CallScope = {
  projectId,
  threadId,
  promptId: askPromptId,
};

/** The durable Thread logs, as the runtime's storage keeps them. */
export interface ThreadLog {
  /** Every row, in append order, across every Thread. */
  readonly rows: ThreadEvent[];
  /** When set, the next appends fail as an unreachable store would. */
  failAppends: boolean;
}

export const threadLog = (): ThreadLog => ({ rows: [], failAppends: false });

/** What `runtime.threads/v1.thread` reports for the Thread under test. */
export interface ThreadState {
  /** Absent: the reader's (main) Thread. */
  origin?: 'user' | 'agent';
  /** The prompt running now; absent while the Thread is idle. */
  activePromptId?: string;
}

/** One `runtime.threads/v1.steer` input the fake received. */
export interface SteerInput {
  readonly id: string;
  readonly prompt: string;
  readonly promptId: string;
  readonly interrupt?: boolean;
}

/** How the fake `steer` answers: a result, or an error it throws. */
export type SteerOutcome = SteerResult | Error;

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

        const scope = call.scope ?? {};

        if (
          scope.projectId === undefined ||
          scope.threadId === undefined ||
          scope.promptId === undefined
        ) {
          throw new ContractError('invalid_scope', 'The row needs a scope.');
        }

        const parsed = event.payload.parse(payload) as Record<string, unknown>;

        log.rows.push({
          projectId: scope.projectId,
          threadId: scope.threadId,
          promptId: scope.promptId,
          sequence:
            log.rows.filter((row) => row.threadId === scope.threadId).length +
            1,
          type: event.type,
          event: { type: event.type, ...parsed },
          createdAt: new Date().toISOString(),
        });
      },
    }),
  });

/** The Thread record `thread` returns for the Thread under test. */
const threadRecord = (state: ThreadState): Thread => ({
  id: threadId,
  projectId,
  name: 'Main',
  state: state.activePromptId === undefined ? 'ready' : 'running',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...(state.origin === undefined ? {} : { origin: state.origin }),
  ...(state.activePromptId === undefined
    ? {}
    : { activePromptId: state.activePromptId }),
});

/** `runtime.threads/v1` for a test: the log read, the Thread, and `steer`. */
const fakeThreads = (
  log: ThreadLog,
  thread: ThreadState,
  steers: SteerInput[],
  steer: { outcome: SteerOutcome | undefined },
): AnyServiceDefinition =>
  defineService(RuntimeThreadsV1.id, {
    threadEvents: defineMethod({
      ...runtimeThreadsMethods.threadEvents,
      execute: async ({ id, afterSequence }) => ({
        events: log.rows.filter(
          (row) => row.threadId === id && row.sequence > afterSequence,
        ),
        lastSequence: log.rows.filter((row) => row.threadId === id).length,
      }),
    }),
    thread: defineMethod({
      ...runtimeThreadsMethods.thread,
      execute: async (id: string) =>
        id === threadId ? threadRecord(thread) : undefined,
    }),
    steer: defineMethod({
      ...runtimeThreadsMethods.steer,
      execute: async (input) => {
        steers.push(input);
        // A real store answers later than the call: let other calls interleave.
        await new Promise((resolve) => setImmediate(resolve));

        const outcome = steer.outcome;

        if (outcome instanceof Error) {
          throw outcome;
        }

        return (
          outcome ??
          ({
            status: thread.activePromptId === undefined ? 'queued' : 'steered',
            promptId: input.promptId,
          } satisfies SteerResult)
        );
      },
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

export interface AskHarnessOptions {
  /** The log to activate over — a fresh one unless a test passes its own. */
  readonly log?: ThreadLog;
  readonly thread?: ThreadState;
  /** How `steer` answers; by default `queued` when idle, else `steered`. */
  readonly steer?: SteerOutcome;
}

export interface AskHarness {
  /** The Thread log the bundle writes into and reads from. */
  readonly log: ThreadLog;
  /** What `thread` reports; a test may change it between calls. */
  readonly thread: ThreadState;
  /** Every input `steer` received, in order. */
  readonly steers: readonly SteerInput[];
  /** Changes how the next `steer` calls answer. */
  steerWith(outcome: SteerOutcome | undefined): void;
  /** A hop call into the bundle, scoped as a prompt's call is. */
  readonly call: (scope?: CallScope) => Call;
  /** `threads.ask/v1`, as the desktop reaches it. */
  readonly ask: Ask;
  /** What the bundle registered in `tools/v1`. */
  readonly registered: readonly Registration[];
  /** Every registered tool, as the agent loop sees them for one prompt call. */
  readonly tools: (scope?: CallScope) => readonly Tool[];
  close(): Promise<void>;
}

export const askHarness = async (
  options: AskHarnessOptions = {},
): Promise<AskHarness> => {
  const log = options.log ?? threadLog();
  const thread: ThreadState = { ...options.thread };
  const steers: SteerInput[] = [];
  const steer = { outcome: options.steer };
  const registered: Registration[] = [];
  const harness = createTestServices({
    bundle: { id: 'threads' },
    provide: [
      fakeEvents(log),
      fakeThreads(log, thread, steers, steer),
      fakeTools(registered),
    ],
  });

  await activate({ services: harness.services });

  return {
    log,
    thread,
    steers,
    steerWith: (outcome) => {
      steer.outcome = outcome;
    },
    call: (scope: CallScope = promptScope) => harness.call(scope),
    ask: harness.services.use(AskV1),
    registered,
    tools: (scope: CallScope = promptScope) =>
      registered.map(({ tool }) => {
        if (!isBoundTool(tool)) {
          throw new TypeError(
            `tools/v1 received an unbound tool: ${tool.name}`,
          );
        }

        return tool.toTool(harness.call(scope));
      }),
    close: async () => {
      await harness.dispose();
    },
  } satisfies AskHarness;
};

/** The rows of one durable type the log holds, in order. */
export const rowsOf = (log: ThreadLog, type: string): ThreadEvent[] =>
  log.rows.filter((row) => row.type === type);
