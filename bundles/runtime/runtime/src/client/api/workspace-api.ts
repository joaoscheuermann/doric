// The records mirror's host adapter (stage 9, §5.8): the Project and Thread reads and
// writes the workspace frame makes, as the desktop main process made them
// over REST before. Each operation runs the main process's payload guard
// first, then the REST route's own input check, then the host contract, and
// turns every outcome the route answered with an error envelope into a
// `ClientError` carrying that envelope's exact message (R-ERR) and a code
// (§6.4). A delete is retried
// every 500 ms while the lifecycle is still active (the port of
// `retryWhileActive`), and a list reads every page, failing on a cursor
// loop. The provisional features add their own adapters.

import { isContractError } from 'bundle/contracts';
import { ClientError } from 'desktop/reads';
import { z } from 'zod';

import {
  type Page,
  type Project,
  type ProjectActivity,
  type ProjectColor,
  projectColors,
  type Thread,
} from '../../contracts/index.js';
import type { RuntimeHost, ThreadsHost } from './host.js';

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
const hostMessage = (code: string): string => {
  if (
    code === 'unavailable' ||
    code === 'disconnected' ||
    code === 'generation_lost'
  ) {
    return hostMessages.unavailable;
  }
  if (code === 'invalid_output') return hostMessages.invalidResponse;
  return hostMessages.failed;
};

/**
 * A failed host call as the adapter rejects with it (§6.4): a contract error
 * keeps its code and is the cause, unless it is `internal`; anything else is
 * `internal` without a cause.
 */
export const hostFailure = (error: unknown): ClientError =>
  isContractError(error) && error.code !== 'internal'
    ? new ClientError(error.code, hostMessage(error.code), { cause: error })
    : new ClientError('internal', hostMessages.failed);

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
    throw new ClientError('invalid_input', hostMessages.invalidName);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > 80) {
    throw new ClientError('invalid_input', hostMessages.nameLength);
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
    throw new ClientError('invalid_input', hostMessages.invalidIdentifier);
  }
  return value;
};

const guardColor = (value: unknown): ProjectColor | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !(projectColors as readonly string[]).includes(value)
  ) {
    throw new ClientError('invalid_input', hostMessages.invalidColor);
  }
  return value as ProjectColor;
};

// The REST routes' own input checks ------------------------------------------

const uuid = z.uuid();

const routeId = (value: string, message: string): string => {
  if (!uuid.safeParse(value).success) {
    throw new ClientError('invalid_input', message);
  }
  return value;
};

const found = <Value>(value: Value | undefined, message: string): Value => {
  if (value === undefined) throw new ClientError('not_found', message);
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
    if (result === 'missing')
      throw new ClientError('not_found', missingMessage);
    // An agent Thread is the agent's to delete: the reader may only pause,
    // continue and retry it, and the host says so instead of deleting.
    if (result === 'forbidden')
      throw new ClientError(
        'conflict',
        'An agent opened this Thread, so it cannot be deleted until it is archived.',
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
      throw new ClientError('invalid_output', hostMessages.invalidResponse);
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
    /**
     * Archives the Thread and its idle, unpinned descendants as one batch
     * (`runtime.threads/v1.archiveThread`). Resolves with the batch, to pass
     * to `restore` for Undo, and every Thread the archive marked, target
     * first. Rejects with a `ClientError`: `not_found` "The thread was not
     * found." for `missing`; `conflict` "The thread is running, so it cannot
     * be archived." for `busy` and "The thread is already archived." for
     * `already_archived`; an invalid id as the other Thread writes do; a
     * rejected host call (`limit_exceeded` included) through `hostFailure`.
     * A rejection wrote nothing.
     */
    archive(
      threadId: string,
    ): Promise<{ readonly batch: string; readonly threads: readonly Thread[] }>;
    /**
     * Un-archives the Thread and its descendants of one batch: `batch`, else
     * the Thread's own (`runtime.threads/v1.restoreThread`). Resolves with
     * every restored Thread. Rejects with a `ClientError`: `not_found` "The
     * thread was not found." for `missing`; `conflict` "The thread is not
     * archived." for `not_archived`; otherwise as `archive`. A rejection
     * wrote nothing.
     */
    restore(threadId: string, batch?: string): Promise<readonly Thread[]>;
    /**
     * Pins or unpins the Thread (`runtime.threads/v1.setThreadPinned`) and
     * resolves with its record. A missing Thread (the host's `undefined`)
     * rejects with `ClientError('not_found', "The thread was not found.")`;
     * other failures as `archive`.
     */
    setPinned(threadId: string, pinned: boolean): Promise<Thread>;
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
          throw new ClientError('invalid_input', hostMessages.invalidThread);
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
          throw new ClientError('not_found', hostMessages.projectNotFound);
        }
        throw new ClientError('conflict', hostMessages.threadConflict);
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
      archive: async (id) => {
        const thread = threadId(id);
        const result = await host(() => threads.archiveThread({ id: thread }));
        if (result.status === 'archived') {
          return { batch: result.batch, threads: result.threads };
        }
        if (result.status === 'missing') {
          throw new ClientError('not_found', hostMessages.threadNotFound);
        }
        throw new ClientError(
          'conflict',
          result.status === 'busy'
            ? 'The thread is running, so it cannot be archived.'
            : 'The thread is already archived.',
        );
      },
      restore: async (id, batch) => {
        const thread = threadId(id);
        const result = await host(() =>
          threads.restoreThread({
            id: thread,
            ...(batch === undefined ? {} : { batch }),
          }),
        );
        if (result.status === 'restored') return result.threads;
        if (result.status === 'missing') {
          throw new ClientError('not_found', hostMessages.threadNotFound);
        }
        throw new ClientError('conflict', 'The thread is not archived.');
      },
      setPinned: async (id, pinned) => {
        const thread = threadId(id);
        return found(
          await host(() => threads.setThreadPinned({ id: thread, pinned })),
          hostMessages.threadNotFound,
        );
      },
    },
  };
};
