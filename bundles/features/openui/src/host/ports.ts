// What `openui`'s host logic calls outside itself (phase 3, S56, D1): the
// `runtime.threads/v1` operations it uses and the `openui.answered/v1` append.
// The kernel entry binds them to `services.use`; the process binds them to the
// router (`./routed.ts`).

import { type Call, EventsV1, type Services } from 'bundle/contracts';
import {
  type PromptResult,
  type ResumeResult,
  RuntimeThreadsV1,
  type SteerResult,
  type ThreadEvent,
} from 'runtime/contracts';

import { type AskAnswer, answeredEvent } from '../contracts/index.js';

/** What `openui` reads of a Thread: its Project, whether an agent owns it, and the prompt running now. */
export interface OpenuiThread {
  readonly projectId: string;
  /** `'agent'` for an agent's Thread; any other value or absent is the reader's. */
  readonly origin?: string;
  readonly activePromptId?: string;
}

/** What `openui` reads of a Thread's queue: whether it is paused and empty. */
export interface OpenuiQueue {
  readonly paused: boolean;
  readonly current?: unknown;
  readonly resumable?: unknown;
  readonly items: readonly unknown[];
}

/** A stored row of a Thread's log as the question state reads it; `event` is the stored JSON body, `type` included. */
export type OpenuiRow = Pick<
  ThreadEvent,
  'projectId' | 'threadId' | 'type' | 'event'
>;

/** A `validation` instruct (the only one `openui` gives). */
export interface OpenuiInstruct {
  readonly id: string;
  readonly prompt: string;
  readonly reason: string;
  readonly promptId?: string;
}

/**
 * The `runtime.threads/v1` operations `openui` uses. Each rejects with the
 * provider's `ContractError` (code and message as `runtime` answers them; a
 * routed failure through `contractErrorOf`), and answers today's domain
 * values. A method given `call` runs as part of that call (its deadline and
 * signal); one given none runs outside every call.
 */
export interface OpenuiThreads {
  /** Every row of the Thread's log, in sequence order (`ThreadEvents{id, afterSequence: 0}`); `[]` when the Thread has no log. */
  rows(threadId: string, call: Call): Promise<readonly OpenuiRow[]>;
  /** The Thread, or `undefined` when `runtime` knows none by that id. */
  thread(id: string, call: Call): Promise<OpenuiThread | undefined>;
  steer(
    input: {
      readonly id: string;
      readonly prompt: string;
      readonly promptId: string;
    },
    call: Call,
  ): Promise<SteerResult>;
  /** The Thread's queue, or `undefined` for an unknown Thread. */
  queue(id: string, call: Call): Promise<OpenuiQueue | undefined>;
  resumeQueue(id: string, call: Call): Promise<Pick<ResumeResult, 'status'>>;
  prompt(
    input: { readonly id: string; readonly prompt: string },
    call: Call,
  ): Promise<PromptResult>;
  instruct(input: OpenuiInstruct, call?: Call): Promise<SteerResult>;
}

/** The scope an answer is recorded under: the question's Thread and the prompt that took the answers. */
export interface AnsweredScope {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
}

/** The body of one `openui.answered/v1` row. */
export interface AnsweredPayload {
  readonly questionPromptId: string;
  /** Hex SHA-256 of the parsed questions' JSON. */
  readonly digest: string;
  readonly answers: readonly AskAnswer[];
}

/** What `openui`'s host logic calls outside itself. */
export interface OpenuiPorts {
  readonly threads: OpenuiThreads;
  /**
   * Appends one `openui.answered/v1` row under `scope`. Resolves once
   * `events/v1` accepted it; rejects with its `ContractError` (`invalid_scope`
   * while no sink serves the Thread's stream, `unknown_event`, …). Appends
   * nothing on a rejection.
   */
  appendAnswered(
    scope: AnsweredScope,
    payload: AnsweredPayload,
    call: Call,
  ): Promise<void>;
}

/**
 * The kernel's ports: each method is today's `services.use(RuntimeThreadsV1)`
 * / `services.use(EventsV1, scope)` call, made when the method runs (no call
 * at creation). `rows` answers `log?.events ?? []`. Kernel only; leaves with
 * the kernel (group F).
 */
export const kernelOpenuiPorts = (services: Services): OpenuiPorts => {
  const threads = () => services.use(RuntimeThreadsV1);

  return {
    threads: {
      rows: async (threadId, call) =>
        (await threads().threadEvents({ id: threadId, afterSequence: 0 }, call))
          ?.events ?? [],
      thread: (id, call) => threads().thread(id, call),
      steer: (input, call) => threads().steer(input, call),
      queue: (id, call) => threads().queue(id, call),
      resumeQueue: (id, call) => threads().resumeQueue(id, call),
      prompt: (input, call) => threads().prompt(input, call),
      instruct: (input, call) =>
        call === undefined
          ? threads().instruct(input)
          : threads().instruct(input, call),
    },
    appendAnswered: async (scope, payload, call) => {
      await services.use(EventsV1, { ...scope }).append(
        answeredEvent,
        {
          questionPromptId: payload.questionPromptId,
          digest: payload.digest,
          answers: [...payload.answers],
        },
        call,
      );
    },
  };
};
