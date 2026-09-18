import type { Project as StoredProject } from '../generated/prisma/client.js';
import type { DoricConfig } from './config.js';
import type { Database } from './database.js';
import type { Project, ProjectStore } from './workspace.js';
import {
  checkLimit,
  excludedStates,
  json,
  page,
  states,
  storedState,
  terminal,
  timestamps,
} from './workspace-storage.js';

/** Persists environment snapshots independently from conversations. */
export const createProjectStore = (database: Database): ProjectStore => ({
  async create(snapshot) {
    const stored = await database.project.create({
      data: {
        configRevision: snapshot.revision,
        configSnapshot: json(snapshot),
      },
    });
    return { project: project(stored), snapshot };
  },

  async find(id) {
    const stored = await database.project.findUnique({ where: { id } });
    return stored === null
      ? undefined
      : {
          project: project(stored),
          snapshot: stored.configSnapshot as unknown as DoricConfig,
        };
  },

  async list(limit, cursor) {
    checkLimit(limit);
    const anchor =
      cursor === undefined
        ? undefined
        : await database.project.findUnique({ where: { id: cursor } });
    if (anchor === null) return { items: [] };
    const records = await database.project.findMany({
      where:
        anchor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
              ],
            },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return page(records.map(project), limit);
  },

  async setState(id, state, errorCode) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.project.findUnique({ where: { id } });
      if (current === null) return undefined;
      if (excludedStates(state).some((value) => value === current.state))
        return project(current);
      return project(
        await tx.project.update({
          where: { id },
          data: {
            state: storedState[state],
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

  async delete(id) {
    return database.$transaction(async (tx) => {
      // Thread creation takes the same project lock, closing the check/delete gap.
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.project.findUnique({ where: { id } });
      if (current === null) return 'missing';
      if (!terminal.some((state) => state === current.state)) return 'active';
      if (
        await tx.thread.count({
          where: { projectId: id, state: { notIn: [...terminal] } },
        })
      )
        return 'active';
      await tx.project.delete({ where: { id } });
      return 'deleted';
    });
  },

  async reconcile() {
    const result = await database.project.updateMany({
      where: { state: { notIn: [...terminal] } },
      data: {
        state: 'FAILED',
        errorCode: 'process_interrupted',
        finishedAt: new Date(),
      },
    });
    return result.count;
  },
});

const project = (stored: StoredProject): Project => ({
  id: stored.id,
  state: states[stored.state],
  configRevision: stored.configRevision,
  ...timestamps(stored),
});
