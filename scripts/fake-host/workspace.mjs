// Dev-only: the in-memory workspace the fake host answers with.
//
// Two Projects and one Thread each, enough for the desktop's sidebar, project
// tabs and dashboard to draw a real tree. The identifiers are fixed UUIDs: the
// workspace routes and `runtime/v1.watchProject` validate them as UUIDs.

import { randomUUID } from 'node:crypto';

/** A fixed moment, so every fake record reads the same on every boot. */
const EPOCH = '2024-01-01T00:00:00.000Z';

/**
 * The Project and Thread the feature surfaces work in: the desktop's first
 * project tab and its Thread, seeded with the scripted conversation. Every
 * artifact, comment and prompt event belongs to them, since the bridge carries
 * no call scope to read a different one from.
 */
export const MAIN_PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const MAIN_THREAD_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SANDBOX_PROJECT_ID = '22222222-2222-4222-8222-222222222222';
export const SANDBOX_THREAD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const project = (id, name, color, index) => ({
  id,
  name,
  color,
  state: 'ready',
  configRevision: 1,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  activityAt: index,
});

const thread = (id, projectId, name, index) => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: `/workspace/${name.toLowerCase()}`,
  createdAt: EPOCH,
  updatedAt: EPOCH,
  activityAt: index,
});

/** The fake workspace: the Projects, their Threads and the mutations over them. */
export const createWorkspace = () => {
  const projects = [
    project(MAIN_PROJECT_ID, 'Doric', 'violet', 2),
    project(SANDBOX_PROJECT_ID, 'Sandbox', 'teal', 1),
  ];
  const threads = [
    thread(MAIN_THREAD_ID, projects[0].id, 'Main', 2),
    thread(SANDBOX_THREAD_ID, projects[1].id, 'Main', 1),
  ];

  const now = () => new Date().toISOString();
  const present = (value) => value !== undefined;
  const projectById = (id) => projects.find((item) => item.id === id);
  const threadById = (id) => threads.find((item) => item.id === id);
  const threadsOf = (projectId) =>
    threads.filter((item) => item.projectId === projectId);

  return {
    projects,
    threads,
    projectById,
    threadById,
    threadsOf,
    /** `runtime/v1.projects`: one page; the fake tree is smaller than a page. */
    projectPage: ({ limit, cursor }) => {
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = projects.slice(start, start + limit);

      return {
        items,
        ...(start + limit < projects.length
          ? { nextCursor: String(start + limit) }
          : {}),
      };
    },
    threadPage: ({ projectId, limit, cursor }) => {
      const all = threadsOf(projectId);
      const start = cursor === undefined ? 0 : Number(cursor);

      return { items: all.slice(start, start + limit) };
    },
    /** `runtime/v1.projectActivity`: most recently active first. */
    projectActivity: () =>
      [...projects]
        .sort((left, right) => right.activityAt - left.activityAt)
        .map((item) => ({
          project: item,
          activityAt: item.updatedAt,
          latestActiveThreadId: threadsOf(item.id)[0]?.id,
        })),
    createProject: ({ name }) => {
      const created = project(randomUUID(), name, 'blue', projects.length + 10);

      projects.push(created);

      return created;
    },
    renameProject: ({ id, name }) => {
      const found = projectById(id);

      if (found === undefined) return undefined;

      found.name = name;
      found.updatedAt = now();

      return found;
    },
    setProjectColor: ({ id, color }) => {
      const found = projectById(id);

      if (found === undefined) return undefined;

      if (color === null) delete found.color;
      else found.color = color;
      found.updatedAt = now();

      return found;
    },
    terminateProject: (id) => {
      const found = projectById(id);

      if (found === undefined) return undefined;

      found.state = 'cancelled';
      found.finishedAt = now();
      found.updatedAt = found.finishedAt;

      return found;
    },
    deleteProject: (id) => {
      const index = projects.findIndex((item) => item.id === id);

      if (index === -1) return 'missing';

      projects.splice(index, 1);

      for (let at = threads.length - 1; at >= 0; at -= 1) {
        if (threads[at].projectId === id) threads.splice(at, 1);
      }

      return 'deleted';
    },
    createThread: ({ projectId, name, parentThreadId }) => {
      const owner = projectById(projectId);

      if (owner === undefined) return { status: 'missing' };
      if (present(parentThreadId) && !present(threadById(parentThreadId))) {
        return { status: 'invalid_parent' };
      }

      const created = thread(
        randomUUID(),
        projectId,
        name === '' ? 'Thread' : name,
        threads.length + 10,
      );
      const entry = present(parentThreadId)
        ? { ...created, parentThreadId }
        : created;

      threads.push(entry);

      return { status: 'created', thread: entry };
    },
    renameThread: ({ id, name }) => {
      const found = threadById(id);

      if (found === undefined) return undefined;

      found.name = name;
      found.updatedAt = now();

      return found;
    },
    terminateThread: (id) => {
      const found = threadById(id);

      if (found === undefined) return undefined;

      found.state = 'cancelled';
      found.finishedAt = now();
      found.updatedAt = found.finishedAt;

      return found;
    },
    deleteThread: (id) => {
      const index = threads.findIndex((item) => item.id === id);

      if (index === -1) return 'missing';

      threads.splice(index, 1);

      return 'deleted';
    },
  };
};
