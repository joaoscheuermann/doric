import {
  type Project,
  type ProjectUpdate,
  type Thread,
  threadsForProject,
  threadSubtreeIds,
  upsert,
  withoutThreadSubtree,
} from '@/domain/workspace';
import { type Dispatch, type SetStateAction, useEffect, useRef } from 'react';

export type ProjectEventsOptions = {
  readonly projectId: string | undefined;
  readonly threadsByProject: Readonly<Record<string, readonly Thread[]>>;
  readonly setProjects: Dispatch<SetStateAction<readonly Project[]>>;
  readonly setThreadsByProject: Dispatch<
    SetStateAction<Readonly<Record<string, readonly Thread[]>>>
  >;
  readonly setOpenThreads: Dispatch<SetStateAction<readonly Thread[]>>;
  readonly setSelectedProjectId: Dispatch<SetStateAction<string | undefined>>;
  readonly setSelectedThreadId: Dispatch<SetStateAction<string | undefined>>;
  readonly fail: (message: string) => void;
};

/**
 * Mirrors the selected Project's live subscription into the cached tree, so a
 * Thread created by an agent appears without a reload. Header tabs stay
 * user-driven: a new Thread is never opened as a tab here.
 */
export const useProjectEvents = (options: ProjectEventsOptions): void => {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const { projectId } = options;

  useEffect(() => {
    if (projectId === undefined) return;
    return window.doric.projects.watch(projectId, (update: ProjectUpdate) => {
      const {
        threadsByProject,
        setProjects,
        setThreadsByProject,
        setOpenThreads,
        setSelectedProjectId,
        setSelectedThreadId,
        fail,
      } = latest.current;
      switch (update.kind) {
        case 'snapshot':
          setThreadsByProject((current) => ({
            ...current,
            [update.snapshot.projectId]: threadsForProject(
              update.snapshot.threads,
              update.snapshot.projectId,
            ),
          }));
          return;
        case 'thread-updated':
          setThreadsByProject((current) => ({
            ...current,
            [update.thread.projectId]: upsert(
              threadsForProject(
                current[update.thread.projectId] ?? [],
                update.thread.projectId,
              ),
              // The server lists Threads in creation order, so an agent-created
              // Thread lands after its siblings instead of jumping to the top.
              update.thread,
              'last',
            ),
          }));
          setOpenThreads((current) =>
            current.map((thread) =>
              thread.id === update.thread.id ? update.thread : thread,
            ),
          );
          return;
        case 'thread-deleted': {
          const removed = threadSubtreeIds(
            threadsByProject[update.projectId] ?? [],
            update.threadId,
          );
          setThreadsByProject((current) => ({
            ...current,
            [update.projectId]: withoutThreadSubtree(
              current[update.projectId] ?? [],
              update.threadId,
            ),
          }));
          setOpenThreads((current) =>
            current.filter((thread) => !removed.has(thread.id)),
          );
          setSelectedThreadId((current) =>
            current !== undefined && removed.has(current) ? undefined : current,
          );
          return;
        }
        case 'project-updated':
          setProjects((current) => upsert(current, update.project));
          return;
        case 'project-deleted':
          setProjects((current) =>
            current.filter((project) => project.id !== update.projectId),
          );
          setThreadsByProject((current) =>
            Object.fromEntries(
              Object.entries(current).filter(([id]) => id !== update.projectId),
            ),
          );
          setOpenThreads((current) =>
            current.filter((thread) => thread.projectId !== update.projectId),
          );
          setSelectedProjectId((current) =>
            current === update.projectId ? undefined : current,
          );
          setSelectedThreadId((current) =>
            threadsByProject[update.projectId]?.some(
              (thread) => thread.id === current,
            )
              ? undefined
              : current,
          );
          return;
        case 'error':
          fail(update.message);
          return;
      }
    });
  }, [projectId]);
};
