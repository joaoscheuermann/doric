// The layout's host adapter (stage 9, §5.8): the Project and Thread reads and
// writes the workspace frame makes, as the desktop main process made them
// over REST before. Each operation runs the main process's payload guard
// first, then the REST route's own input check, then the host contract, and
// turns every outcome the route answered with an error envelope into an
// `Error` carrying that envelope's exact message (R-ERR). A delete is retried
// every 500 ms while the lifecycle is still active (the port of
// `retryWhileActive`), and a list reads every page, failing on a cursor
// loop. The provisional features add their own adapters.

import { isContractError, type Services } from 'bundle/contracts';
import type {
  Page,
  Project,
  ProjectActivity,
  ProjectColor,
  Thread,
} from 'runtime/contracts';
import { z } from 'zod';

import { projectColors } from '../domain/workspace.js';
import {
  type RuntimeHost,
  RuntimeThreadsV1,
  RuntimeV1,
  type ThreadsHost,
} from './host.js';

/** The page size of every list read. */
const pageLimit = 100;

export const hostMessages = {
  unavailable: 'Doric backend is unavailable.',
  invalidResponse: 'Doric returned an invalid response.',
  /** The REST 500 envelope: any other host failure. */
  failed: 'The request could not be completed.',
  invalidName: 'Enter a valid name before continuing.',
  nameLength: 'Enter a name between 1 and 80 characters.',
  invalidIdentifier: 'The item identifier is invalid.',
  invalidColor: 'Choose a color from the palette.',
  invalidProjectId: 'The project ID is invalid.',
  invalidThreadId: 'The thread ID is invalid.',
  invalidThread:
    'A Thread name between 1 and 80 characters and optional parentThreadId are accepted.',
  projectNotFound: 'The project was not found.',
  threadNotFound: 'The thread was not found.',
  threadConflict: 'The thread cannot perform this operation.',
} as const;

/** The message a failed host call shows, as the REST path showed it. */
export const hostFailure = (error: unknown): Error => {
  if (isContractError(error)) {
    if (
      error.code === 'unavailable' ||
      error.code === 'disconnected' ||
      error.code === 'generation_lost'
    ) {
      return new Error(hostMessages.unavailable);
    }
    if (error.code === 'invalid_output') {
      return new Error(hostMessages.invalidResponse);
    }
  }
  return new Error(hostMessages.failed);
};

const host = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw hostFailure(error);
  }
};

// The main process's payload guards (`workspace/validation.ts`) ------------

const guardName = (value: unknown): string => {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(hostMessages.invalidName);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > 80) {
    throw new Error(hostMessages.nameLength);
  }
  return trimmed;
};

const guardIdentifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(hostMessages.invalidIdentifier);
  }
  return value;
};

const guardColor = (value: unknown): ProjectColor | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !(projectColors as readonly string[]).includes(value)
  ) {
    throw new Error(hostMessages.invalidColor);
  }
  return value as ProjectColor;
};

// The REST routes' own input checks ------------------------------------------

const uuid = z.uuid();

const routeId = (value: string, message: string): string => {
  if (!uuid.safeParse(value).success) throw new Error(message);
  return value;
};

const found = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new Error(message);
  return value;
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Deletes once the lifecycle allows it: an `active` answer (the REST 409) is
 * retried after `pause`, `missing` is the REST 404.
 */
export const deleteWhenTerminal = async (
  remove: () => Promise<'deleted' | 'active' | 'missing' | 'forbidden'>,
  missingMessage: string,
  pause: () => Promise<void> = () => wait(500),
): Promise<void> => {
  for (;;) {
    const result = await host(remove);
    if (result === 'deleted') return;
    if (result === 'missing') throw new Error(missingMessage);
    // An agent Thread is the agent's to delete: the reader may only pause,
    // continue and retry it, and the host says so instead of deleting.
    if (result === 'forbidden')
      throw new Error(
        'An agent opened this Thread, so it cannot be deleted.',
      );
    await pause();
  }
};

/** Every page of a cursor list; a repeated cursor is an invalid response. */
export const allPages = async <Value>(
  read: (cursor: string | undefined) => Promise<Page<Value>>,
): Promise<readonly Value[]> => {
  const items: Value[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined && cursors.has(cursor)) {
      throw new Error(hostMessages.invalidResponse);
    }
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);

  return items;
};

const pageOf = (cursor: string | undefined) =>
  cursor === undefined ? { limit: pageLimit } : { limit: pageLimit, cursor };

export interface WorkspaceApi {
  readonly projects: {
    list(): Promise<readonly Project[]>;
    activity(): Promise<readonly ProjectActivity[]>;
    create(name: string): Promise<Project>;
    rename(projectId: string, name: string): Promise<Project>;
    /** Assigns a palette color, or clears it when none is named. */
    setColor(projectId: string, color?: ProjectColor): Promise<Project>;
    terminate(projectId: string): Promise<Project>;
    delete(projectId: string): Promise<void>;
  };
  readonly threads: {
    list(projectId: string): Promise<readonly Thread[]>;
    /** A Thread that no longer exists is `undefined`, not a failure. */
    get(threadId: string): Promise<Thread | undefined>;
    create(
      projectId: string,
      name: string,
      parentThreadId?: string,
    ): Promise<Thread>;
    rename(threadId: string, name: string): Promise<Thread>;
    terminate(threadId: string): Promise<Thread>;
    delete(threadId: string): Promise<void>;
  };
}

export interface WorkspaceHosts {
  readonly runtime: RuntimeHost;
  readonly threads: ThreadsHost;
  /** The pause between delete attempts; 500 ms by default. */
  readonly pause?: () => Promise<void>;
}

export const createWorkspaceApi = ({
  runtime,
  threads,
  pause,
}: WorkspaceHosts): WorkspaceApi => {
  const projectId = (value: unknown) =>
    routeId(guardIdentifier(value), hostMessages.invalidProjectId);
  const threadId = (value: unknown) =>
    routeId(guardIdentifier(value), hostMessages.invalidThreadId);

  return {
    projects: {
      list: () =>
        allPages((cursor) => host(() => runtime.projects(pageOf(cursor)))),
      activity: () => host(() => runtime.projectActivity()),
      create: async (name) => {
        const valid = guardName(name);
        return await host(() => runtime.createProject({ name: valid }));
      },
      rename: async (id, name) => {
        guardIdentifier(id);
        const valid = guardName(name);
        const project = projectId(id);
        return found(
          await host(() => runtime.renameProject({ id: project, name: valid })),
          hostMessages.projectNotFound,
        );
      },
      setColor: async (id, color) => {
        guardIdentifier(id);
        const valid = guardColor(color);
        const project = projectId(id);
        return found(
          await host(() =>
            runtime.setProjectColor({ id: project, color: valid ?? null }),
          ),
          hostMessages.projectNotFound,
        );
      },
      terminate: async (id) => {
        const project = projectId(id);
        return found(
          await host(() => runtime.terminateProject(project)),
          hostMessages.projectNotFound,
        );
      },
      delete: async (id) => {
        const project = projectId(id);
        await deleteWhenTerminal(
          () => runtime.deleteProject(project),
          hostMessages.projectNotFound,
          pause,
        );
      },
    },
    threads: {
      list: async (id) => {
        const project = projectId(id);
        return await allPages(async (cursor) =>
          found(
            await host(() =>
              threads.threads({ projectId: project, ...pageOf(cursor) }),
            ),
            hostMessages.projectNotFound,
          ),
        );
      },
      get: async (id) => {
        const thread = threadId(id);
        return await host(() => threads.thread(thread));
      },
      create: async (id, name, parentThreadId) => {
        guardIdentifier(id);
        const valid = name === '' ? '' : guardName(name);
        if (parentThreadId !== undefined) guardIdentifier(parentThreadId);
        const project = projectId(id);
        // `parentThreadId` is sent only when non-empty, as the REST body was.
        const parent = parentThreadId ? parentThreadId : undefined;
        if (parent !== undefined && !uuid.safeParse(parent).success) {
          throw new Error(hostMessages.invalidThread);
        }
        const result = await host(() =>
          threads.createThread({
            projectId: project,
            name: valid,
            ...(parent === undefined ? {} : { parentThreadId: parent }),
          }),
        );
        if (result.status === 'created') return result.thread;
        if (result.status === 'missing') {
          throw new Error(hostMessages.projectNotFound);
        }
        throw new Error(hostMessages.threadConflict);
      },
      rename: async (id, name) => {
        guardIdentifier(id);
        const valid = guardName(name);
        const thread = threadId(id);
        return found(
          await host(() => threads.renameThread({ id: thread, name: valid })),
          hostMessages.threadNotFound,
        );
      },
      terminate: async (id) => {
        const thread = threadId(id);
        return found(
          await host(() => threads.terminateThread(thread)),
          hostMessages.threadNotFound,
        );
      },
      delete: async (id) => {
        const thread = threadId(id);
        await deleteWhenTerminal(
          () => threads.deleteThread(thread),
          hostMessages.threadNotFound,
          pause,
        );
      },
    },
  };
};

let current: WorkspaceApi | undefined;

/** Binds the adapter to the layout's activation services (D9-17). */
export const initWorkspaceApi = (services: Services): void => {
  current = createWorkspaceApi({
    runtime: services.use(RuntimeV1),
    threads: services.use(RuntimeThreadsV1),
  });
};

export const disposeWorkspaceApi = (): void => {
  current = undefined;
};

const bound = (): WorkspaceApi => {
  if (current === undefined) {
    throw new Error(hostMessages.unavailable);
  }
  return current;
};

/** The adapter the components and hooks call, once the bundle is active. */
export const api: WorkspaceApi = {
  projects: {
    list: () => bound().projects.list(),
    activity: () => bound().projects.activity(),
    create: (name) => bound().projects.create(name),
    rename: (id, name) => bound().projects.rename(id, name),
    setColor: (id, color) => bound().projects.setColor(id, color),
    terminate: (id) => bound().projects.terminate(id),
    delete: (id) => bound().projects.delete(id),
  },
  threads: {
    list: (id) => bound().threads.list(id),
    get: (id) => bound().threads.get(id),
    create: (id, name, parent) => bound().threads.create(id, name, parent),
    rename: (id, name) => bound().threads.rename(id, name),
    terminate: (id) => bound().threads.terminate(id),
    delete: (id) => bound().threads.delete(id),
  },
};
