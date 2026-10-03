import type { Project as StoredProject } from '../../generated/prisma/client.js';
import type { DoricConfig } from '../config/schema.js';
import type { Database } from '../database.js';
import { isProjectColor } from './colors.js';
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
import type { Project, ProjectStore } from './types.js';

/** What a record read selects; `configSnapshot` stays out of it. */
const recordColumns = {
  id: true,
  name: true,
  color: true,
  state: true,
  configRevision: true,
  errorCode: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

/** Persists environment snapshots independently from conversations. */
export const createProjectStore = (database: Database): ProjectStore => ({
  async create(name, snapshot, color) {
    const stored = await database.project.create({
      data: {
        name,
        color,
        configRevision: snapshot.revision,
        configSnapshot: json(snapshot),
      },
      select: recordColumns,
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

  async record(id) {
    const stored = await database.project.findUnique({
      where: { id },
      select: recordColumns,
    });
    return stored === null ? undefined : project(stored);
  },

  async list(limit, cursor) {
    checkLimit(limit);
    const anchor =
      cursor === undefined
        ? undefined
        : await database.project.findUnique({
            where: { id: cursor },
            select: { createdAt: true, id: true },
          });
    if (anchor === null) return { items: [] };
    const records = await database.project.findMany({
      where: before(anchor),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: recordColumns,
    });
    return page(records.map(project), limit);
  },

  async rename(id, name) {
    const result = await database.project.updateMany({
      where: { id },
      data: { name },
    });
    if (result.count === 0) return undefined;
    const stored = await database.project.findUnique({
      where: { id },
      select: recordColumns,
    });
    return stored === null ? undefined : project(stored);
  },

  async setColor(id, color) {
    const result = await database.project.updateMany({
      where: { id },
      data: { color: color ?? null },
    });
    if (result.count === 0) return undefined;
    const stored = await database.project.findUnique({
      where: { id },
      select: recordColumns,
    });
    return stored === null ? undefined : project(stored);
  },

  async setState(id, state, errorCode) {
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM project WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.project.findUnique({
        where: { id },
        select: recordColumns,
      });
      if (current === null) return undefined;
      if (excludedStates(state).some((value) => value === current.state))
        return project(current);
      return project(
        await tx.project.update({
          where: { id },
          select: recordColumns,
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
      const current = await tx.project.findUnique({
        where: { id },
        select: { state: true },
      });
      if (current === null) return 'missing';
      if (!terminal.some((state) => state === current.state)) return 'active';
      if (
        await tx.thread.count({
          where: { projectId: id, state: { notIn: [...terminal] } },
        })
      )
        return 'active';
      await tx.project.delete({ where: { id }, select: { id: true } });
      return 'deleted';
    });
  },

  async reconcile() {
    // A host that restarted resumes its Projects rather than failing them, but
    // it completes a termination it finds in progress: CANCELLING means the user
    // terminated the Project, so reviving it would resurrect work they stopped.
    // It returns how many Projects the resume pass moved to `queued`; a
    // completed termination is not resumed and is not counted.
    await database.project.updateMany({
      where: { state: { notIn: [...terminal] }, errorCode: { not: null } },
      data: { errorCode: null },
    });
    await database.project.updateMany({
      where: { state: 'CANCELLING' },
      data: { state: 'CANCELLED', finishedAt: new Date() },
    });
    const result = await database.project.updateMany({
      where: { state: { notIn: [...terminal, 'CANCELLING', 'QUEUED'] } },
      data: { state: 'QUEUED' },
    });
    return result.count;
  },
});

const project = (stored: Omit<StoredProject, 'configSnapshot'>): Project => ({
  id: stored.id,
  name: stored.name,
  // Only the vocabulary this host writes ever reaches a client.
  ...(isProjectColor(stored.color) ? { color: stored.color } : {}),
  state: states[stored.state],
  configRevision: stored.configRevision,
  ...timestamps(stored),
});
