import { randomUUID } from 'node:crypto';

import type { ProviderMessage } from 'llms';

import type {
  ThreadEvent as StoredEvent,
  Thread as StoredThread,
} from '../../generated/prisma/client.js';
import type { Database } from '../database.js';
import type { PauseReason, PromptFailure, PromptProgress } from './prompts.js';
import { delegatedResult } from './prompts.js';
import { queueSnapshot } from './queue.js';
import {
  before,
  checkLimit,
  excludedStates,
  json,
  page,
  states,
  storable,
  storedState,
  terminal,
  timestamps,
} from './storage.js';
import type {
  CwdRepo,
  InputSource,
  Thread,
  ThreadEvent,
  ThreadStore,
} from './types.js';
import {
  readThreadUsage,
  readUsageState,
  rewindUsage,
  writeUsage,
} from './usage-store.js';

/** What a record read selects; `messages` and `checkpoints` stay out of it. */
const recordColumns = {
  id: true,
  projectId: true,
  parentThreadId: true,
  name: true,
  state: true,
  queuePaused: true,
  cwd: true,
  cwdRepo: true,
  activePromptId: true,
  errorCode: true,
  lastSequence: true,
  resultText: true,
  resultStatus: true,
  resultPromptId: true,
  resultAt: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

/** Persists immutable conversation trees, provider history and ordered replay. */
export const createThreadStore = (database: Database): ThreadStore => ({
  appendEvents: (id, promptId, values) =>
    database.$transaction(async (tx) => {
      const events: ThreadEvent[] = [];
      for (const value of values)
        events.push(await writeEvent(tx, id, promptId, value));
      return events;
    }),
  queue: (id) =>
    database.$transaction(
      async (tx) => {
        const stored = await tx.thread.findUnique({
          where: { id },
          select: recordColumns,
        });
        if (stored === null) return undefined;
        const progress = await unfinishedPrompts(tx, [stored]);
        const related = await tx.thread.findMany({
          where: { projectId: stored.projectId },
          select: { id: true, name: true },
        });
        return queueSnapshot(
          thread(stored),
          progress,
          new Map(related.map((row) => [row.id, row.name])),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  usage: (id) => readThreadUsage(database, id),
  create(projectId, name, parentThreadId, inherit) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${projectId}::uuid FOR UPDATE`;
      const owner = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { state: true },
      });
      if (owner.state !== 'QUEUED' && owner.state !== 'READY')
        throw new Error('Inactive project.');
      if (parentThreadId !== undefined) {
        const ancestors = await tx.$queryRaw<{ state: string }[]>`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_thread_id, state FROM thread
            WHERE id = ${parentThreadId}::uuid AND project_id = ${projectId}::uuid
            UNION ALL
            SELECT t.id, t.parent_thread_id, t.state FROM thread t
            JOIN ancestors a ON t.id = a.parent_thread_id
          ) SELECT state FROM ancestors`;
        if (
          ancestors.length === 0 ||
          ancestors.some(
            ({ state }) =>
              state === 'CANCELLING' ||
              state === 'FAILED' ||
              state === 'CANCELLED',
          )
        ) {
          throw new Error('Invalid parent thread.');
        }
      }
      const stored = await tx.thread.create({
        data: {
          projectId,
          name,
          parentThreadId,
          ...(inherit === undefined
            ? {}
            : { cwd: inherit.cwd, cwdRepo: inherit.cwdRepo ?? null }),
        },
        select: recordColumns,
      });
      return { thread: thread(stored), messages: [], checkpoints: {} };
    });
  },

  async find(id) {
    const stored = await database.thread.findUnique({ where: { id } });
    return stored === null
      ? undefined
      : {
          thread: thread(stored),
          messages: stored.messages as unknown as readonly ProviderMessage[],
          checkpoints: checkpoints(stored),
        };
  },

  async record(id) {
    const stored = await database.thread.findUnique({
      where: { id },
      select: recordColumns,
    });
    return stored === null ? undefined : thread(stored);
  },

  async list(projectId, limit, cursor, parentThreadId) {
    checkLimit(limit);
    const scope = {
      projectId,
      ...(parentThreadId === undefined ? {} : { parentThreadId }),
    };
    const anchor =
      cursor === undefined
        ? undefined
        : await database.thread.findFirst({
            where: { ...scope, id: cursor },
            select: { createdAt: true, id: true },
          });
    if (anchor === null) return { items: [] };
    const records = await database.thread.findMany({
      where: {
        ...scope,
        ...before(anchor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: recordColumns,
    });
    return page(records.map(thread), limit);
  },

  async listByProject(projectId) {
    return (
      await database.thread.findMany({
        where: { projectId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: recordColumns,
      })
    ).map(thread);
  },

  async rename(id, name) {
    const result = await database.thread.updateMany({
      where: { id },
      data: { name },
    });
    if (result.count === 0) return undefined;
    const stored = await database.thread.findUnique({
      where: { id },
      select: recordColumns,
    });
    return stored === null ? undefined : thread(stored);
  },

  async setCwd(id, cwd, cwdRepo) {
    // The directory and its hint are one write: a hint can never describe a
    // directory the Thread is no longer in.
    const result = await database.thread.updateMany({
      where: { id },
      data: { cwd, cwdRepo: cwdRepo ?? null },
    });
    if (result.count === 0) return undefined;
    const stored = await database.thread.findUnique({
      where: { id },
      select: recordColumns,
    });
    return stored === null ? undefined : thread(stored);
  },

  setState(id, state, activePromptId, errorCode) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM thread WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.thread.findUnique({
        where: { id },
        select: recordColumns,
      });
      if (current === null) return undefined;
      if (excludedStates(state).some((value) => value === current.state))
        return thread(current);
      return thread(
        await tx.thread.update({
          where: { id },
          select: recordColumns,
          data: {
            state: storedState[state],
            activePromptId:
              state === 'running' ? (activePromptId ?? null) : null,
            errorCode: errorCode ?? null,
            ...(state === 'ready' && current.startedAt === null
              ? { startedAt: new Date() }
              : {}),
            ...(state === 'failed' || state === 'cancelled'
              ? { finishedAt: new Date() }
              : {}),
          },
        }),
      );
    });
  },

  async saveMessages(id, messages) {
    await database.thread.update({
      where: { id },
      data: { messages: json(messages) },
      select: { id: true },
    });
  },

  async saveCheckpoint(id, promptId) {
    // The database owns the count so it matches the exact history a turn reads.
    // A turn records its boundary once: a turn that is resumed already has the
    // one it started at, and writing the length it reads now would make the
    // history it continues from look like history it had not read yet.
    await database.$executeRaw`
      UPDATE "thread"
      SET "checkpoints" = jsonb_build_object(
        ${promptId}::text, jsonb_array_length("messages")
      ) || "checkpoints"
      WHERE "id" = ${id}::uuid`;
  },

  rewind(id, promptId) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM thread WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.thread.findUnique({ where: { id } });
      if (current === null) return undefined;
      const checkpoint = checkpoints(current)[promptId];
      if (checkpoint === undefined) return undefined;
      const [boundary] = await tx.$queryRaw<{ sequence: number | null }[]>`
        SELECT MIN("sequence") AS sequence FROM "thread_event"
        WHERE "thread_id" = ${id}::uuid AND "prompt_id" = ${promptId}::uuid`;
      const from = boundary?.sequence;
      if (from === undefined || from === null) return undefined;
      const removed = await tx.$queryRaw<{ prompt_id: string }[]>`
        SELECT DISTINCT "prompt_id" FROM "thread_event"
        WHERE "thread_id" = ${id}::uuid AND "sequence" >= ${from}`;
      const [survivor] = await tx.$queryRaw<{ sequence: number | null }[]>`
        SELECT MAX("sequence") AS sequence FROM "thread_event"
        WHERE "thread_id" = ${id}::uuid AND "sequence" < ${from}`;
      const afterSequence = survivor?.sequence ?? 0;
      const previousUsage = await readUsageState(tx, id, current.usage);
      await tx.threadEvent.deleteMany({
        where: { threadId: id, sequence: { gte: from } },
      });
      await rewindUsage(tx, id, previousUsage);
      const updated = await tx.thread.update({
        where: { id },
        data: {
          messages: json(
            (current.messages as unknown as readonly ProviderMessage[]).slice(
              0,
              checkpoint,
            ),
          ),
          checkpoints: json(prune(current, removed)),
          lastSequence: { increment: 1 },
        },
        select: { projectId: true, lastSequence: true },
      });
      return event(
        await tx.threadEvent.create({
          data: {
            projectId: updated.projectId,
            threadId: id,
            promptId,
            sequence: updated.lastSequence,
            type: 'history.truncated',
            event: json({ type: 'history.truncated', afterSequence }),
          },
        }),
      );
    });
  },

  appendEvent: (id, promptId, value) =>
    appendEvent(database, id, promptId, value),

  async eventsAfter(id, sequence) {
    return (
      await database.threadEvent.findMany({
        where: { threadId: id, sequence: { gt: sequence } },
        orderBy: { sequence: 'asc' },
      })
    ).map(event);
  },

  async eventsAfterPage(id, sequence, limit) {
    checkLimit(limit);
    const rows = await database.threadEvent.findMany({
      where: { threadId: id, sequence: { gt: sequence } },
      orderBy: { sequence: 'asc' },
      take: limit + 1,
    });
    const events = rows.slice(0, limit).map(event);
    const last = events.at(-1);
    return {
      events,
      ...(rows.length > limit && last !== undefined
        ? { nextSequence: last.sequence }
        : {}),
    };
  },

  async setResult(id, result) {
    await database.thread.updateMany({
      where: { id },
      data: {
        resultText: storable(result.text),
        resultStatus: result.status,
        resultPromptId: result.promptId,
        resultAt: new Date(result.at),
      },
    });
  },

  async unfinishedPrompts(id) {
    return unfinishedPrompts(database, await openThreads(database, id));
  },

  async failPrompt(prompt, failure) {
    await closePrompt(database, prompt, failure);
  },

  deleteSubtree(id) {
    return database.$transaction(async (tx) => {
      const current = await tx.thread.findUnique({
        where: { id },
        select: { projectId: true },
      });
      if (current === null) return 'missing';
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${current.projectId}::uuid FOR UPDATE`;
      const subtree = await tx.$queryRaw<{ id: string; state: string }[]>`
        WITH RECURSIVE subtree AS (
          SELECT id, state FROM thread WHERE id = ${id}::uuid
          UNION ALL
          SELECT t.id, t.state FROM thread t JOIN subtree s ON t.parent_thread_id = s.id
        ) SELECT id, state FROM subtree`;
      if (subtree.length === 0) return 'missing';
      if (
        subtree.some(({ state }) => state !== 'FAILED' && state !== 'CANCELLED')
      )
        return 'active';
      await tx.thread.delete({ where: { id }, select: { id: true } });
      return 'deleted';
    });
  },

  async reconcile() {
    // A host that restarted resumes its Threads rather than failing them, and its
    // Threads stay resumable too: a prompt whose run started but never recorded a
    // pause was interrupted by the restart itself, so the reboot records that
    // reason and leaves the prompt unfinished for the boot to take up. Nothing is
    // closed here; a prompt that never started is already resumable as it stands.
    // It returns how many Threads the resume pass moved to `ready`; a termination
    // completed here is not resumed and is not counted.
    const live = await openThreads(database);
    for (const prompt of await unfinishedPrompts(database, live))
      if (prompt.started && prompt.paused === undefined)
        await appendEvent(database, prompt.threadId, prompt.promptId, {
          type: 'prompt.paused',
          reason: 'host_restarted',
        });
    // A resumed record carries no stale error.
    await database.thread.updateMany({
      where: { state: { notIn: [...terminal] }, errorCode: { not: null } },
      data: { errorCode: null },
    });
    // Complete a termination the previous host began instead of resuming it:
    // CANCELLING is a user's termination, not work a restart should revive.
    await database.thread.updateMany({
      where: { state: 'CANCELLING' },
      data: {
        state: 'CANCELLED',
        activePromptId: null,
        finishedAt: new Date(),
      },
    });
    const result = await database.thread.updateMany({
      where: { state: { notIn: [...terminal, 'CANCELLING', 'READY'] } },
      data: { state: 'READY', activePromptId: null },
    });
    return result.count;
  },
});

const thread = (
  stored: Omit<StoredThread, 'messages' | 'checkpoints' | 'usage'>,
): Thread => ({
  id: stored.id,
  projectId: stored.projectId,
  ...(stored.parentThreadId === null
    ? {}
    : { parentThreadId: stored.parentThreadId }),
  name: stored.name,
  state: states[stored.state],
  queuePaused: stored.queuePaused,
  lastSequence: stored.lastSequence,
  cwd: stored.cwd,
  ...(stored.cwdRepo === null ? {} : { cwdRepo: stored.cwdRepo as CwdRepo }),
  ...(stored.activePromptId === null
    ? {}
    : { activePromptId: stored.activePromptId }),
  ...(stored.resultText === null ||
  stored.resultStatus === null ||
  stored.resultPromptId === null ||
  stored.resultAt === null
    ? {}
    : {
        result: {
          status: stored.resultStatus,
          text: stored.resultText,
          promptId: stored.resultPromptId,
          at: stored.resultAt.toISOString(),
        },
      }),
  ...timestamps(stored),
});

const checkpoints = (stored: StoredThread): Readonly<Record<string, number>> =>
  stored.checkpoints as unknown as Readonly<Record<string, number>>;

const prune = (
  stored: StoredThread,
  removed: readonly { readonly prompt_id: string }[],
): Readonly<Record<string, number>> => {
  const ids = new Set(removed.map(({ prompt_id }) => prompt_id));
  return Object.fromEntries(
    Object.entries(checkpoints(stored)).filter(([id]) => !ids.has(id)),
  );
};

const event = (stored: StoredEvent): ThreadEvent => ({
  projectId: stored.projectId,
  threadId: stored.threadId,
  promptId: stored.promptId,
  sequence: stored.sequence,
  type: stored.type,
  event: stored.event,
  createdAt: stored.createdAt.toISOString(),
});

/**
 * Appends one ordered event, taking the row lock before reading the sequence so
 * writers in another host process cannot collide. Shared by the store and the
 * boot reconcile, which records a pause from outside a run.
 */
const appendEvent = (
  database: Database,
  id: string,
  promptId: string,
  value: unknown,
): Promise<ThreadEvent> => {
  return database.$transaction((tx) => writeEvent(tx, id, promptId, value));
};

/** Writes an event inside the caller's transaction. */
const writeEvent = async (
  tx: Pick<Database, 'thread' | 'threadEvent'>,
  id: string,
  promptId: string,
  value: unknown,
): Promise<ThreadEvent> => {
  const current = await tx.thread.update({
    where: { id },
    data: { lastSequence: { increment: 1 } },
    select: { projectId: true, lastSequence: true, usage: true },
  });
  const type =
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
      ? value.type
      : 'unknown';
  if (type === 'queue.paused' || type === 'queue.resumed')
    await tx.thread.update({
      where: { id },
      data: { queuePaused: type === 'queue.paused' },
      select: { id: true },
    });
  await writeUsage(tx, id, type, value, current.usage);
  return event(
    await tx.threadEvent.create({
      data: {
        projectId: current.projectId,
        threadId: id,
        promptId,
        sequence: current.lastSequence,
        type,
        event: json(value),
      },
    }),
  );
};

/**
 * The Threads a host resume pass may act on: the non-terminal ones, or the named
 * one. Its state and owner are all the pass needs to name the Project a prompt
 * belongs to.
 */
const openThreads = (database: Database, id?: string) =>
  database.thread.findMany({
    where: {
      state: { notIn: [...terminal] },
      ...(id === undefined ? {} : { id }),
    },
    select: { id: true, projectId: true },
  });

/** The event types that decide whether a prompt is unfinished, and how. */
const progressTypes = [
  'prompt.accepted',
  'prompt.edited',
  'prompt.started',
  'prompt.finished',
  'prompt.paused',
  'prompt.resumed',
  'agent.started',
] as const;

const pauseReasons = [
  'host_stopped',
  'host_restarted',
  'reader_stopped',
] as const;

const isPauseReason = (value: unknown): value is PauseReason =>
  (pauseReasons as readonly unknown[]).includes(value);

/** What one prompt's events amount to while the log is folded over them. */
type Progress = {
  -readonly [Key in keyof PromptProgress]: PromptProgress[Key];
};

/**
 * Every prompt the log accepted without a `prompt.finished` counterpart, over
 * the given Threads, in the order the log accepted them. `prompt.finished` is
 * the one event that closes a turn, so an accepted prompt that never reached it
 * — whether the host died while it was running or after `enqueue` persisted it
 * but before the job ran — is exactly the unfinished set, and the rest of its
 * events say why it stopped: whether a run started at all, the pause that still
 * stands, and how many times it was taken up again. The accepted event carries
 * the input text and the source the host resumes the prompt with, so a resumed
 * run asks for the same thing and a delegated prompt stays correlated.
 */
const unfinishedPrompts = async (
  database: Pick<Database, 'threadEvent'>,
  threads: readonly { readonly id: string; readonly projectId: string }[],
): Promise<readonly PromptProgress[]> => {
  if (threads.length === 0) return [];
  const owners = new Map(threads.map(({ id, projectId }) => [id, projectId]));
  const rows = await database.threadEvent.findMany({
    where: {
      threadId: { in: [...owners.keys()] },
      type: { in: [...progressTypes] },
    },
    orderBy: [{ sequence: 'asc' }, { threadId: 'asc' }],
    select: {
      threadId: true,
      promptId: true,
      type: true,
      event: true,
      sequence: true,
      createdAt: true,
    },
  });
  const pending = new Map<string, Progress>();
  for (const row of rows) {
    const projectId = owners.get(row.threadId);
    if (projectId === undefined) continue;
    const key = `${row.threadId}:${row.promptId}`;
    if (row.type === 'prompt.accepted') {
      if (pending.has(key)) continue;
      const accepted = row.event as {
        readonly text?: string;
        readonly source?: InputSource;
        readonly queued?: boolean;
      } | null;
      if (
        accepted?.queued !== true &&
        (accepted?.source === undefined || accepted.source.kind === 'user')
      ) {
        for (const previous of pending.values()) {
          if (
            previous.threadId === row.threadId &&
            previous.paused !== undefined
          )
            previous.superseded = true;
        }
      }
      pending.set(key, {
        projectId,
        threadId: row.threadId,
        promptId: row.promptId,
        text: accepted?.text ?? '',
        revision: row.sequence,
        source: accepted?.source ?? { kind: 'user' },
        started: false,
        attempts: 0,
        acceptedAt: row.createdAt.toISOString(),
        queuedSequence: row.sequence,
      });
      continue;
    }
    const progress = pending.get(key);
    // Only a prompt this read accepted can be unfinished, and it cannot be
    // closed before it was accepted.
    if (progress === undefined) continue;
    if (row.type === 'prompt.finished') pending.delete(key);
    else if (row.type === 'agent.started' || row.type === 'prompt.started')
      progress.started = true;
    else if (row.type === 'prompt.edited') {
      const text = (row.event as { text?: unknown } | null)?.text;
      if (typeof text === 'string') {
        progress.text = text;
        progress.revision = row.sequence;
      }
    } else if (row.type === 'prompt.resumed') {
      progress.attempts += 1;
      progress.paused = undefined;
      progress.queuedSequence = row.sequence;
      progress.first =
        (row.event as { first?: boolean } | null)?.first === true;
    } else {
      const reason = (row.event as { readonly reason?: unknown } | null)
        ?.reason;
      if (isPauseReason(reason)) {
        progress.paused = reason;
        progress.pausedSequence = row.sequence;
      }
    }
  }
  return [...pending.values()];
};

/**
 * Closes one unfinished prompt the host will not take up again, durably and in
 * the shape a failed run produces: the failure event naming why, the finished
 * event carrying the source the accepted input recorded, and the materialized
 * result. Nothing is left looking live.
 */
const closePrompt = async (
  database: Database,
  prompt: PromptProgress,
  failure: PromptFailure,
): Promise<void> => {
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM thread WHERE id = ${prompt.threadId}::uuid FOR UPDATE`;
    if (
      await tx.threadEvent.findFirst({
        where: {
          threadId: prompt.threadId,
          promptId: prompt.promptId,
          type: 'prompt.finished',
        },
      })
    )
      return;
    await writeEvent(tx, prompt.threadId, prompt.promptId, {
      type: 'agent.failed',
      error: failure,
    });
    await writeEvent(tx, prompt.threadId, prompt.promptId, {
      type: 'prompt.finished',
      status: 'failed',
      text: 'The prompt failed.',
      source: prompt.source,
    });
    await tx.thread.updateMany({
      where: { id: prompt.threadId },
      data: {
        resultText: storable('The prompt failed.'),
        resultStatus: 'failed',
        resultPromptId: prompt.promptId,
        resultAt: new Date(),
      },
    });
    if (prompt.source.kind !== 'parent') return;
    const parent = await tx.thread.findFirst({
      where: {
        id: prompt.source.threadId,
        projectId: prompt.projectId,
        state: { notIn: [...terminal, 'CANCELLING'] },
      },
      select: { id: true },
    });
    if (parent === null) return;
    const resultId = randomUUID();
    await writeEvent(tx, parent.id, resultId, {
      type: 'prompt.accepted',
      queued: true,
      text: delegatedResult(
        prompt.threadId,
        prompt.promptId,
        prompt.source.promptId,
        'failed',
        failure.message,
      ),
      source: {
        kind: 'result',
        threadId: prompt.threadId,
        promptId: prompt.promptId,
        requestPromptId: prompt.source.promptId,
      },
    });
    await writeEvent(tx, parent.id, resultId, { type: 'prompt.queued' });
  });
};
