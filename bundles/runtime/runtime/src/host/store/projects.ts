import { randomUUID } from 'node:crypto';

import type { DoricConfiguration } from '../../contracts/configuration.js';
import {
  isProjectColor,
  type Project,
  type ProjectState,
} from '../../contracts/model.js';
import type { RuntimeOwner } from '../../contracts/runtime.js';
import {
  createdKey,
  type ProjectDocument,
  projectType,
  type ThreadDocument,
  threadEventsStream,
  threadType,
} from '../../contracts/storage.js';
import { type AttachmentStore, collect } from './attachments.js';
import { type DocumentSet, queryAll } from './documents.js';
import { historyParts } from './history.js';
import {
  checkLimit,
  excludedStates,
  isOpenState,
  isTerminalState,
  now,
  page,
  storableJson,
  timestamps,
} from './records.js';
import type { ProjectStore } from './types.js';

const sameOwner = (
  left: RuntimeOwner | null | undefined,
  right: RuntimeOwner,
): boolean =>
  left !== null &&
  left !== undefined &&
  left.generation === right.generation &&
  left.incarnation === right.incarnation;

/*
 * Projects on `runtime.project/v1`, ported from
 * agents/doric/src/lib/workspace/projects.ts. The configuration snapshot is
 * kept verbatim and never read for execution.
 */

/** The public record; only the vocabulary this host writes reaches a client. */
export const toProject = (stored: ProjectDocument): Project => ({
  id: stored.id,
  name: stored.name,
  ...(isProjectColor(stored.color) ? { color: stored.color } : {}),
  state: stored.state,
  configRevision: stored.configRevision,
  ...timestamps(stored),
});

/** The document after a write that changes it (`updatedAt` moves). */
const touched = (
  stored: ProjectDocument,
  change: Partial<ProjectDocument>,
): ProjectDocument => {
  const next = { ...stored, ...change, updatedAt: now() };
  return { ...next, open: isOpenState(next.state) };
};

export const createProjectStore = (
  set: DocumentSet,
  attachments: Pick<AttachmentStore, 'records' | 'collect'>,
): ProjectStore => {
  const { storage } = set;
  const projects = set.documents<ProjectDocument>(projectType.type);

  /** A rename or recolor: missing answers undefined. */
  const update = (id: string, change: Partial<ProjectDocument>) =>
    projects.mutate(id, (current) =>
      current === undefined
        ? { done: () => undefined }
        : (() => {
            const value = touched(current.value, change);
            return { value, done: () => toProject(value) };
          })(),
    );

  return {
    create(name, snapshot, color, owner) {
      const id = randomUUID();
      const at = now();
      const value: ProjectDocument = {
        id,
        name,
        color,
        state: 'queued',
        open: true,
        configRevision: snapshot.revision,
        configSnapshot: storableJson(snapshot),
        errorCode: null,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        finishedAt: null,
        createdKey: createdKey(at, id),
        ...(owner === undefined ? {} : { owner: { ...owner } }),
      };
      return projects.mutate(id, () => ({
        value,
        done: () => ({ project: toProject(value), snapshot }),
      }));
    },

    async find(id) {
      const stored = await projects.get(id);
      return stored === undefined
        ? undefined
        : {
            project: toProject(stored.value),
            snapshot: stored.value.configSnapshot as DoricConfiguration,
          };
    },

    async record(id) {
      const stored = await projects.get(id);
      return stored === undefined ? undefined : toProject(stored.value);
    },

    async list(limit, cursor) {
      checkLimit(limit);
      const anchor =
        cursor === undefined ? undefined : await projects.get(cursor);
      if (cursor !== undefined && anchor === undefined) return { items: [] };
      const records = await queryAll(
        storage,
        {
          type: projectType.type,
          index: 'byCreated',
          equals: [],
          order: 'desc',
          ...(anchor === undefined
            ? {}
            : { range: { lt: anchor.value.createdKey } }),
        },
        limit + 1,
      );
      return page(
        records.map(({ value }) => toProject(value as ProjectDocument)),
        limit,
      );
    },

    rename: (id, name) => update(id, { name }),

    setColor: (id, color) => update(id, { color: color ?? null }),

    setState: (id, state, errorCode) =>
      projects.mutate(id, (current) => {
        if (current === undefined) return { done: () => undefined };
        if (excludedStates(state).includes(current.value.state))
          return { done: () => toProject(current.value) };
        const at = now();
        const value = touched(current.value, {
          state: state as ProjectState as ProjectDocument['state'],
          errorCode: errorCode ?? null,
          ...(state === 'ready' && current.value.startedAt === null
            ? { startedAt: at }
            : {}),
          ...(state === 'failed' || state === 'cancelled'
            ? { finishedAt: at }
            : {}),
        });
        return { value, done: () => toProject(value) };
      }),

    delete: (id) =>
      projects.mutate(id, async (current) => {
        if (current === undefined) return { done: () => 'missing' as const };
        if (!isTerminalState(current.value.state))
          return { done: () => 'active' as const };
        const threads = await queryAll(storage, {
          type: threadType.type,
          index: 'byProject',
          equals: [id],
        });
        if (
          threads.some(
            ({ value }) => !isTerminalState((value as ThreadDocument).state),
          )
        )
          return { done: () => 'active' as const };
        const parts = (
          await Promise.all(
            threads.map(({ id: threadId }) => historyParts(storage, threadId)),
          )
        ).flat();
        const images = await attachments.records({ projectId: id });
        return {
          batch: {
            expect: threads.map(({ id: threadId, revision }) => ({
              type: threadType.type,
              id: threadId,
              revision,
            })),
            delete: [
              { type: projectType.type, id },
              ...threads.map(({ id: threadId }) => ({
                type: threadType.type,
                id: threadId,
              })),
              ...parts,
              ...images.keys,
            ],
            ...(threads.length === 0
              ? {}
              : {
                  dropStreams: threads.map(({ id: threadId }) =>
                    threadEventsStream(threadId),
                  ),
                }),
          },
          done: async () => {
            await collect(attachments, images.ids);
            return 'deleted' as const;
          },
        };
      }),

    async owners() {
      const open = await queryAll(storage, {
        type: projectType.type,
        index: 'byOpen',
        equals: [true],
      });
      return new Map(
        open.map(({ id, value }) => [
          id,
          (value as ProjectDocument).owner ?? null,
        ]),
      );
    },

    claim: (id, owner, live) =>
      projects.mutate(id, (current) => {
        if (current === undefined) return { done: () => false };
        const held = current.value.owner;
        if (sameOwner(held, owner)) return { done: () => true };
        if (held !== null && held !== undefined && live(held))
          return { done: () => false };
        // Ownership is internal: the public record and `updatedAt` stay.
        return {
          value: { ...current.value, owner: { ...owner } },
          done: () => true,
        };
      }),

    release: (id, owner) =>
      projects.mutate(id, (current) =>
        current === undefined || !sameOwner(current.value.owner, owner)
          ? { done: () => undefined }
          : {
              value: { ...current.value, owner: null },
              done: () => undefined,
            },
      ),

    async reconcile(include) {
      // A host that restarted resumes its Projects rather than failing them,
      // but it completes a termination it finds in progress: CANCELLING means
      // the user terminated the Project, so reviving it would resurrect work
      // they stopped. It returns how many Projects the resume pass moved to
      // `queued`; a completed termination is not resumed and is not counted.
      const open = await queryAll(storage, {
        type: projectType.type,
        index: 'byOpen',
        equals: [true],
      });
      let resumed = 0;
      for (const { id } of open) {
        if (include !== undefined && !include(id)) continue;
        const moved = await projects.mutate(id, (current) => {
          if (current === undefined || isTerminalState(current.value.state))
            return { done: () => false };
          const stored = current.value;
          const at = now();
          const change: Partial<ProjectDocument> =
            stored.state === 'cancelling'
              ? { state: 'cancelled', finishedAt: at }
              : stored.state === 'queued'
                ? {}
                : { state: 'queued' };
          const value: ProjectDocument | undefined =
            stored.errorCode === null && Object.keys(change).length === 0
              ? undefined
              : touched(stored, { ...change, errorCode: null });
          return {
            ...(value === undefined ? {} : { value }),
            done: () => change.state === 'queued',
          };
        });
        if (moved) resumed += 1;
      }
      return resumed;
    },
  };
};
