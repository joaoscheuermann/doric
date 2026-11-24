// The three `Watch` streams and the page cut of `transport`'s host part (S60d, contract s60 §2.9, D5, D6).

import { create } from '@bufbuild/protobuf';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  ContractError,
  fromConnectError,
  isContractError,
} from 'bundle/contracts';
import type {
  ThreadsService as RuntimeThreadsService,
  WatchThreadResponse,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import type {
  WatchProjectResponse as RuntimeProjectItem,
  ProjectSnapshot as RuntimeProjectSnapshot,
  RuntimeService,
} from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';
import type {
  ProjectTerminals,
  WatchProjectResponse as TerminalProjectItem,
  TerminalService,
} from 'terminal/contracts/gen/doric/terminal/v1/terminal_pb.js';

import {
  ProjectSnapshotSchema,
  type WatchResponse as ProjectWatchItem,
  WatchResponseSchema as ProjectWatchItemSchema,
} from '../../contracts/gen/doric/api/projects/v1/projects_pb.js';
import {
  type WatchResponse as StatusWatchItem,
  WatchResponseSchema as StatusWatchItemSchema,
} from '../../contracts/gen/doric/api/status/v1/status_pb.js';
import {
  type WatchResponse as ThreadWatchItem,
  WatchResponseSchema as ThreadWatchItemSchema,
  type WatchRequest as ThreadWatchRequest,
} from '../../contracts/gen/doric/api/threads/v1/threads_pb.js';
import { apiFailure } from '../api/answer.js';

/** What a source stream delivers: an item, its end, or its failure. */
type Pulled<T> =
  | { readonly kind: 'item'; readonly item: T }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly error: unknown };

/** A queue one consumer awaits while sources put into it. */
const inbox = <T>() => {
  const queue: T[] = [];
  let wake: (() => void) | undefined;

  return {
    put: (entry: T): void => {
      queue.push(entry);
      wake?.();
      wake = undefined;
    },
    take: async (): Promise<T> => {
      for (;;) {
        const entry = queue.shift();

        if (entry !== undefined) return entry;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

/** Reads `open(signal)` into `deliver` until it ends or fails; never rejects. */
const pump = async <T>(
  open: (signal: AbortSignal) => AsyncIterable<T>,
  signal: AbortSignal,
  deliver: (pulled: Pulled<T>) => void,
): Promise<void> => {
  try {
    for await (const item of open(signal)) deliver({ kind: 'item', item });
    deliver({ kind: 'end' });
  } catch (error) {
    deliver({ kind: 'error', error });
  }
};

/**
 * Opens `opens` under a signal that aborts with `signal` or `release` (which cancels them), and puts what they
 * deliver into one inbox; `take` gives `'aborted'` once that signal aborts.
 */
const sourcesOf = <T>(
  signal: AbortSignal,
  ...opens: ((signal: AbortSignal) => AsyncIterable<T>)[]
) => {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const box = inbox<Pulled<T> | 'aborted'>();

  controller.signal.addEventListener('abort', () => box.put('aborted'), {
    once: true,
  });
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  if (!controller.signal.aborted) {
    for (const open of opens) void pump(open, controller.signal, box.put);
  }

  return {
    take: box.take,
    release: () => {
      signal.removeEventListener('abort', stop);
      controller.abort();
    },
  };
};

/** A source opened again after a generation change (its second snapshot, Q4). */
const interrupted = (): ContractError =>
  new ContractError(
    'unavailable',
    'The workspace stream was interrupted; open it again.',
  );

/** A source that could not deliver its snapshot (today's `workspace:error`). */
const replayFailed = (): ContractError =>
  new ContractError('replay_failed', 'The snapshot could not be loaded.');

/** A Thread source's failure: `replay_failed` passes unchanged, anything else as `apiFailure` reads it. */
const threadFailure = (error: unknown): ContractError => {
  const failure =
    error instanceof ConnectError ? fromConnectError(error) : error;

  return isContractError(failure) && failure.code === 'replay_failed'
    ? failure
    : apiFailure(error);
};

/**
 * `ThreadsService.Watch` (D5): `WatchThread{threadId, afterSequence}` relayed item by item (snapshot → thread_snapshot,
 * event → agent_event, updated → thread_updated, deleted → thread_deleted). Ends when `signal` aborts (the call's), when
 * the source ends, or with `ContractError('unavailable', …)` at a second snapshot; a source failure ends it as
 * `apiFailure` reads it (`replay_failed` passes, Q3).
 */
export async function* threadWatch(
  threads: Pick<Client<typeof RuntimeThreadsService>, 'watchThread'>,
  request: ThreadWatchRequest,
  signal: AbortSignal,
): AsyncIterable<ThreadWatchItem> {
  const sources = sourcesOf(signal, async function* (current) {
    const { threadId, afterSequence } = request;

    for await (const { item } of threads.watchThread(
      { threadId, afterSequence },
      { signal: current },
    )) {
      yield threadEventOf(item);
    }
  });

  try {
    let snapshots = 0;

    for (;;) {
      const entry = await sources.take();

      if (entry === 'aborted' || entry.kind === 'end') return;
      if (entry.kind === 'error') throw threadFailure(entry.error);
      if (entry.item.case === undefined) continue;
      if (entry.item.case === 'threadSnapshot') {
        snapshots += 1;
        if (snapshots > 1) throw interrupted();
      }
      yield create(ThreadWatchItemSchema, { event: entry.item });
    }
  } finally {
    sources.release();
  }
}

/** One `WatchThread` item as the API Watch's case. */
const threadEventOf = (
  item: WatchThreadResponse['item'],
): ThreadWatchItem['event'] => {
  switch (item.case) {
    case 'snapshot':
      return { case: 'threadSnapshot', value: item.value };
    case 'event':
      return { case: 'agentEvent', value: item.value };
    case 'updated':
      return { case: 'threadUpdated', value: item.value };
    case 'deleted':
      return { case: 'threadDeleted', value: item.value };
    default:
      return { case: undefined };
  }
};

/** One `runtime/v2.WatchProject` notice as the API Watch's case. */
const runtimeNoticeOf = (
  item: RuntimeProjectItem['item'],
): ProjectWatchItem['event'] => {
  switch (item.case) {
    case 'projectUpdated':
      return { case: 'projectUpdated', value: item.value };
    case 'projectDeleted':
      return { case: 'projectDeleted', value: item.value };
    case 'threadUpdated':
      return { case: 'threadUpdated', value: item.value };
    case 'threadDeleted':
      return { case: 'threadDeleted', value: item.value };
    default:
      return { case: undefined };
  }
};

/** One `terminal/v1.WatchProject` notice as the API Watch's case. */
const terminalNoticeOf = (
  item: TerminalProjectItem['item'],
): ProjectWatchItem['event'] => {
  switch (item.case) {
    case 'updated':
      return { case: 'terminalUpdated', value: item.value };
    case 'removed':
      return { case: 'terminalRemoved', value: item.value };
    case 'output':
      return { case: 'terminalOutput', value: item.value };
    default:
      return { case: undefined };
  }
};

/** What either `WatchProject` source brings, read as the API Watch reads it. */
type Arrival =
  | { readonly kind: 'project'; readonly snapshot: RuntimeProjectSnapshot }
  | { readonly kind: 'terminals'; readonly snapshot: ProjectTerminals }
  | { readonly kind: 'notice'; readonly event: ProjectWatchItem['event'] };

const runtimeArrival = ({ item }: RuntimeProjectItem): Arrival =>
  item.case === 'snapshot'
    ? { kind: 'project', snapshot: item.value }
    : { kind: 'notice', event: runtimeNoticeOf(item) };

const terminalArrival = ({ item }: TerminalProjectItem): Arrival =>
  item.case === 'snapshot'
    ? { kind: 'terminals', snapshot: item.value }
    : { kind: 'notice', event: terminalNoticeOf(item) };

/**
 * `ProjectsService.Watch` (D5): both `WatchProject` streams opened at once; `project_snapshot` (with the terminal
 * snapshot's sessions) then `terminal_snapshot` once both snapshots arrived, then the later items of both in arrival
 * order. Before both snapshots: a source failure or end → `ContractError('replay_failed', 'The snapshot could not be
 * loaded.')`; notices held, `terminal_output` dropped. After: a second snapshot → `unavailable`; a failure → `apiFailure`;
 * a source ending → the Watch ends. Cancels both sources when it ends.
 */
export async function* projectWatch(
  runtime: Pick<Client<typeof RuntimeService>, 'watchProject'>,
  terminal: Pick<Client<typeof TerminalService>, 'watchProject'>,
  projectId: string,
  signal: AbortSignal,
): AsyncIterable<ProjectWatchItem> {
  const sources = sourcesOf<Arrival>(
    signal,
    async function* (current) {
      for await (const item of runtime.watchProject(
        { projectId },
        { signal: current },
      )) {
        yield runtimeArrival(item);
      }
    },
    async function* (current) {
      for await (const item of terminal.watchProject(
        { projectId },
        { signal: current },
      )) {
        yield terminalArrival(item);
      }
    },
  );

  const item = (event: ProjectWatchItem['event']): ProjectWatchItem =>
    create(ProjectWatchItemSchema, { event });

  try {
    let project: RuntimeProjectSnapshot | undefined;
    let terminals: ProjectTerminals | undefined;
    let started = false;
    const held: ProjectWatchItem['event'][] = [];

    for (;;) {
      const entry = await sources.take();

      if (entry === 'aborted') return;
      if (entry.kind === 'end') {
        if (!started) throw replayFailed();
        return;
      }
      if (entry.kind === 'error') {
        throw started ? apiFailure(entry.error) : replayFailed();
      }

      const arrival = entry.item;

      if (arrival.kind === 'project') {
        if (project !== undefined) throw interrupted();
        project = arrival.snapshot;
      } else if (arrival.kind === 'terminals') {
        if (terminals !== undefined) throw interrupted();
        terminals = arrival.snapshot;
      } else if (arrival.event.case === undefined) {
        continue;
      } else if (started) {
        yield item(arrival.event);
        continue;
      } else if (arrival.event.case !== 'terminalOutput') {
        // Before both snapshots notices wait and terminal output is dropped (today's `/projects` namespace).
        held.push(arrival.event);
      }

      if (started || project === undefined || terminals === undefined) {
        continue;
      }
      started = true;
      yield item({
        case: 'projectSnapshot',
        value: create(ProjectSnapshotSchema, {
          projectId: project.projectId,
          ...(project.project === undefined
            ? {}
            : { project: project.project }),
          threads: project.threads,
          terminals: terminals.terminals,
        }),
      });
      yield item({ case: 'terminalSnapshot', value: terminals });
      for (const event of held.splice(0)) yield item(event);
    }
  } finally {
    sources.release();
  }
}

/** `StatusService.Watch`: one `{ready: {}}`, then nothing until `signal` aborts; then it ends without error. */
export async function* statusWatch(
  signal: AbortSignal,
): AsyncIterable<StatusWatchItem> {
  yield create(StatusWatchItemSchema, { event: { case: 'ready', value: {} } });
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** 3 MiB (D6). */
export const API_PAGE_MAX_BYTES: number = 3 * 1024 * 1024;

/**
 * The number of leading `items` to keep so that `size(kept)` — the encoded response with those items — is below `max`;
 * at least 1 when `items` is not empty, `items.length` when everything fits. Pure; `size` is called O(log n) times.
 */
export const keptBefore = <T>(
  items: readonly T[],
  size: (kept: readonly T[]) => number,
  max: number = API_PAGE_MAX_BYTES,
): number => {
  if (items.length === 0 || size(items) < max) return items.length;

  // The longest fitting prefix lies in [low, high): `low` items are kept at least, `high` do not fit.
  let low = 1;
  let high = items.length;

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);

    if (size(items.slice(0, middle)) < max) low = middle;
    else high = middle;
  }

  return low;
};
