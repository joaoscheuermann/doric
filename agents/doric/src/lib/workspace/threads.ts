import type { ProviderMessage } from 'llms';
import type {
  Thread as StoredThread,
  ThreadEvent as StoredEvent,
} from '../../generated/prisma/client.js';
import type { Database } from '../database.js';
import type { Thread, ThreadEvent, ThreadStore } from './types.js';
import {
  before,
  checkLimit,
  excludedStates,
  json,
  page,
  states,
  storedState,
  terminal,
  timestamps,
} from './storage.js';

/** Persists immutable conversation trees, provider history and ordered replay. */
export const createThreadStore = (database: Database): ThreadStore => ({
  async create(projectId, parentThreadId) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${projectId}::uuid FOR UPDATE`;
      const owner = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
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
        data: { projectId, parentThreadId },
      });
      return { thread: thread(stored), messages: [] };
    });
  },

  async find(id) {
    const stored = await database.thread.findUnique({ where: { id } });
    return stored === null
      ? undefined
      : {
          thread: thread(stored),
          messages: stored.messages as unknown as readonly ProviderMessage[],
        };
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
        : await database.thread.findFirst({ where: { ...scope, id: cursor } });
    if (anchor === null) return { items: [] };
    const records = await database.thread.findMany({
      where: {
        ...scope,
        ...before(anchor),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return page(records.map(thread), limit);
  },

  async listByProject(projectId) {
    return (
      await database.thread.findMany({
        where: { projectId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(thread);
  },

  async setState(id, state, activePromptId, errorCode) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM thread WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.thread.findUnique({ where: { id } });
      if (current === null) return undefined;
      if (excludedStates(state).some((value) => value === current.state))
        return thread(current);
      return thread(
        await tx.thread.update({
          where: { id },
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
    });
  },

  async appendEvent(id, promptId, value) {
    return database.$transaction(async (tx) => {
      // UPDATE acquires the row lock before reading the sequence, including
      // writers using a different Prisma client or host process.
      const current = await tx.thread.update({
        where: { id },
        data: { lastSequence: { increment: 1 } },
      });
      const type =
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        typeof value.type === 'string'
          ? value.type
          : 'unknown';
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
    });
  },

  async eventsAfter(id, sequence) {
    return (
      await database.threadEvent.findMany({
        where: { threadId: id, sequence: { gt: sequence } },
        orderBy: { sequence: 'asc' },
      })
    ).map(event);
  },

  async deleteSubtree(id) {
    return database.$transaction(async (tx) => {
      const current = await tx.thread.findUnique({ where: { id } });
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
      await tx.thread.delete({ where: { id } });
      return 'deleted';
    });
  },

  async reconcile() {
    const result = await database.thread.updateMany({
      where: { state: { notIn: [...terminal] } },
      data: {
        state: 'FAILED',
        activePromptId: null,
        errorCode: 'process_interrupted',
        finishedAt: new Date(),
      },
    });
    return result.count;
  },
});

const thread = (stored: StoredThread): Thread => ({
  id: stored.id,
  projectId: stored.projectId,
  ...(stored.parentThreadId === null
    ? {}
    : { parentThreadId: stored.parentThreadId }),
  state: states[stored.state],
  lastSequence: stored.lastSequence,
  ...(stored.activePromptId === null
    ? {}
    : { activePromptId: stored.activePromptId }),
  ...timestamps(stored),
});

const event = (stored: StoredEvent): ThreadEvent => ({
  projectId: stored.projectId,
  threadId: stored.threadId,
  promptId: stored.promptId,
  sequence: stored.sequence,
  type: stored.type,
  event: stored.event,
  createdAt: stored.createdAt.toISOString(),
});
