import { randomUUID } from 'node:crypto';

import type { StreamEntry } from 'bundle/contracts';
import { z } from 'zod';

import type { HistoryPatch, HistoryReader } from '../../contracts/executor.js';
import {
  inputSourceSchema,
  type Thread,
  type ThreadEvent,
  type ThreadState,
} from '../../contracts/model.js';
import {
  createdKey,
  type PendingPrompt,
  type ProjectDocument,
  projectType,
  type ThreadDocument,
  type ThreadEventEnvelope,
  threadEventsStream,
  threadType,
} from '../../contracts/storage.js';
import { type AttachmentStore, collect } from './attachments.js';
import { type Cached, type DocumentSet, queryAll } from './documents.js';
import {
  entriesAfter,
  eventsAfter,
  eventsAfterPage,
  eventType,
  toThreadEvent,
} from './events.js';
import { historyParts, historyPuts, historyReader } from './history.js';
import {
  delegatedResult,
  foldAll,
  foldProgress,
  type ProgressEntry,
  toProgress,
} from './progress.js';
import { queueSnapshot } from './queue.js';
import {
  checkLimit,
  excludedStates,
  isOpenState,
  isTerminalState,
  now,
  page,
  storable,
  storableJson,
  timestamps,
} from './records.js';
import type { PromptProgress, ThreadStore } from './types.js';
import {
  foldUsage,
  projectUsage,
  rewoundUsage,
  type SubtreeUsage,
  threadUsage,
  type UsageState,
  usageEventTypes,
} from './usage.js';

/*
 * Threads on `runtime.thread/v1` and their event streams, ported from
 * agents/doric/src/lib/workspace/threads.ts and usage-store.ts (design 57
 * §3.4). The Thread document is the aggregate the former row and its
 * transaction kept consistent: an event append commits the entries with the
 * document's `lastSequence`, queue flag, usage fold, latest `prompt.started`
 * and `pending` projection, all in one commit.
 */

/** How the executor takes part in a rewind (design 57 §4.10). */
export interface RewindParticipation {
  /**
   * The executor's truncated state for `promptId`, or undefined when the
   * prompt has no turn boundary (`unknown_prompt`).
   */
  rewind(input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly history: HistoryReader;
    readonly promptId: string;
    readonly removedPromptIds: readonly string[];
  }): Promise<HistoryPatch | undefined>;
}

export interface ThreadStoreOptions {
  readonly executor: RewindParticipation;
  /**
   * Called once for each event another bundle appended to a Thread's stream
   * (through `events/v1`), after the commit that folds it into the document:
   * `catchUp` (run when `events/v1` reports the append) or, when a runtime
   * commit meets the append first, that commit's `sequence_conflict` retry.
   * The runtime's own events are published by callers.
   */
  readonly publish?: (event: ThreadEvent) => void;
}

/** The former `thread_event.prompt_id uuid` column refused anything else. */
const promptIdSchema = z.uuid();

/** The public record, in the former mapper's key order. */
export const toThread = (stored: ThreadDocument): Thread => ({
  id: stored.id,
  projectId: stored.projectId,
  ...(stored.parentThreadId === null
    ? {}
    : { parentThreadId: stored.parentThreadId }),
  ...(stored.origin === undefined || stored.origin === null
    ? {}
    : { origin: stored.origin }),
  name: stored.name,
  state: stored.state,
  queuePaused: stored.queuePaused,
  lastSequence: stored.lastSequence,
  cwd: stored.cwd,
  ...(stored.cwdRepo === null ? {} : { cwdRepo: stored.cwdRepo }),
  ...(stored.activePromptId === null
    ? {}
    : { activePromptId: stored.activePromptId }),
  ...(stored.result === null
    ? {}
    : {
        result: {
          status: stored.result.status,
          text: stored.result.text,
          promptId: stored.result.promptId,
          at: stored.result.at,
        },
      }),
  ...timestamps(stored),
  ...(stored.state === 'running' && stored.activePromptId !== null
    ? {
        executionStartedAt:
          stored.lastStarted?.promptId === stored.activePromptId
            ? stored.lastStarted.at
            : stored.updatedAt,
      }
    : {}),
  ...(stored.result !== null &&
  stored.lastStarted?.promptId === stored.result.promptId
    ? {
        lastExecutionMs: Math.max(
          0,
          Date.parse(stored.result.at) - Date.parse(stored.lastStarted.at),
        ),
      }
    : {}),
});

/** The document after a write that changes it (`updatedAt` moves). */
const touched = (
  stored: ThreadDocument,
  change: Partial<ThreadDocument>,
): ThreadDocument => {
  const next = { ...stored, ...change, updatedAt: now() };
  return { ...next, open: isOpenState(next.state) };
};

const progressEntry = (entry: StreamEntry): ProgressEntry => {
  const value = entry.value as ThreadEventEnvelope;
  return {
    sequence: entry.sequence,
    promptId: value.promptId,
    type: value.type,
    event: value.event,
    createdAt: entry.createdAt,
  };
};

/** One event about to be appended, before the backend numbers it. */
interface Pending {
  readonly promptId: string;
  readonly type: string;
  /** The storable body. */
  readonly event: unknown;
}

/** What an append computes from the current document. */
interface Appended {
  readonly value: ThreadDocument;
  readonly envelopes: readonly ThreadEventEnvelope[];
  /** The provisional time the fold used for each entry. */
  readonly at: string;
}

export const createThreadStore = (
  set: DocumentSet,
  options: ThreadStoreOptions,
  attachments: Pick<AttachmentStore, 'records' | 'collect'>,
): ThreadStore => {
  const { storage } = set;
  const threads = set.documents<ThreadDocument>(threadType.type);
  const projects = set.documents<ProjectDocument>(projectType.type);

  const all =
    (sequence = 0) =>
    (threadId: string) =>
      entriesAfter(storage, threadId, sequence);

  /** The usage state, derived once from the log when none is stored. */
  const usageOf = async (stored: ThreadDocument): Promise<UsageState> =>
    stored.usage !== null && stored.usage !== undefined
      ? (stored.usage as UsageState)
      : foldUsage(
          (await all()(stored.id)).map((entry) => {
            const value = entry.value as ThreadEventEnvelope;
            return { type: value.type, event: value.event };
          }),
        );

  /** The pending projection, folded from the log when none is stored. */
  const pendingOf = async (
    stored: ThreadDocument,
  ): Promise<readonly PendingPrompt[]> =>
    stored.pending ?? foldAll((await all()(stored.id)).map(progressEntry));

  /**
   * Applies events to a document in order: the counter, the queue flag (a
   * storage pause also records its error), the usage fold, the latest
   * `prompt.started` and the pending projection, as `writeEvent` did one row
   * at a time.
   */
  const applyEvents = async (
    stored: ThreadDocument,
    events: readonly Pending[],
  ): Promise<Appended> => {
    const at = now();
    let usage: UsageState | undefined;
    let pending = await pendingOf(stored);
    let value: ThreadDocument = { ...stored };
    const envelopes: ThreadEventEnvelope[] = [];
    for (const event of events) {
      const sequence = value.lastSequence + 1;
      value = { ...value, lastSequence: sequence };
      if (event.type === 'queue.paused' || event.type === 'queue.resumed')
        value = {
          ...value,
          queuePaused: event.type === 'queue.paused',
          ...(event.type === 'queue.paused' &&
          (event.event as { reason?: string } | null)?.reason === 'storage_low'
            ? { errorCode: 'storage_low' }
            : {}),
        };
      if (usageEventTypes.includes(event.type)) {
        usage = projectUsage(usage ?? (await usageOf(stored)), event.event);
        value = { ...value, usage: storableJson(usage) };
      }
      if (event.type === 'prompt.started')
        value = { ...value, lastStarted: { promptId: event.promptId, at } };
      pending = foldProgress(pending, {
        sequence,
        promptId: event.promptId,
        type: event.type,
        event: event.event,
        createdAt: at,
      });
      envelopes.push({
        projectId: stored.projectId,
        threadId: stored.id,
        promptId: event.promptId,
        type: event.type,
        event: event.event as Record<string, unknown>,
      });
    }
    return {
      value: touched(value, { pending: [...pending] }),
      envelopes,
      at,
    };
  };

  /**
   * Applies intervening stream entries to a document in order, bringing its
   * counter, queue flag, usage fold, latest `prompt.started` and pending
   * projection up to date with events that were committed to the stream
   * outside of ThreadStore (for example, through events/v1).
   */
  const foldIntervening = async (
    stored: ThreadDocument,
    entries: readonly StreamEntry[],
  ): Promise<ThreadDocument> => {
    let value = stored;
    let pending = await pendingOf(stored);
    let usage: UsageState | undefined;
    for (const entry of entries) {
      const envelope = entry.value as ThreadEventEnvelope;
      const sequence = entry.sequence;
      value = { ...value, lastSequence: sequence };
      if (
        envelope.type === 'queue.paused' ||
        envelope.type === 'queue.resumed'
      ) {
        value = {
          ...value,
          queuePaused: envelope.type === 'queue.paused',
          ...(envelope.type === 'queue.paused' &&
          (envelope.event as { reason?: string } | null)?.reason ===
            'storage_low'
            ? { errorCode: 'storage_low' }
            : {}),
        };
      }
      if (usageEventTypes.includes(envelope.type)) {
        usage = projectUsage(usage ?? (await usageOf(stored)), envelope.event);
        value = { ...value, usage: storableJson(usage) };
      }
      if (envelope.type === 'prompt.started') {
        value = {
          ...value,
          lastStarted: { promptId: envelope.promptId, at: entry.createdAt },
        };
      }
      pending = foldProgress(pending, {
        sequence,
        promptId: envelope.promptId,
        type: envelope.type,
        event: envelope.event,
        createdAt: entry.createdAt,
      });
    }
    return touched(value, { pending: [...pending] });
  };

  /**
   * The stored document brought up to the stream's head when a commit's
   * append was refused. Other bundles append to a Thread's stream through
   * `events/v1` without touching the document, so its `lastSequence` can lag
   * the stream; the first attempt stays optimistic (the append path's cost is
   * one commit and one read), and a `sequence_conflict` retry reads what
   * follows the document and folds it before appending again.
   */
  const caughtUp = async (
    stored: ThreadDocument,
    attempt: number,
  ): Promise<{
    readonly base: ThreadDocument;
    readonly intervening: readonly StreamEntry[];
  }> => {
    if (attempt === 0) return { base: stored, intervening: [] };
    const intervening = await entriesAfter(
      storage,
      stored.id,
      stored.lastSequence,
    );
    return {
      base:
        intervening.length > 0
          ? await foldIntervening(stored, intervening)
          : stored,
      intervening,
    };
  };

  /**
   * Publishes the externally appended entries a successful commit folded in,
   * once: the document now covers them, so no later commit reads them again.
   */
  const publishIntervening = (entries: readonly StreamEntry[]): void => {
    if (options.publish === undefined) return;
    for (const entry of entries) options.publish(toThreadEvent(entry));
  };

  /** Validates and sanitizes events before anything is committed. */
  const prepare = (promptId: string, values: readonly unknown[]): Pending[] => {
    promptIdSchema.parse(promptId);
    return values.map((value) => ({
      promptId,
      type: eventType(value),
      event: storableJson(value),
    }));
  };

  /**
   * The entries a commit appended, read back for their protocol time. The
   * fold used a provisional time for `acceptedAt` and the latest start;
   * when the backend's differs, a second write of the same document puts
   * the backend's in (without moving `updatedAt`).
   */
  const appendedEvents = async (
    threadId: string,
    after: number,
    count: number,
    at: string,
  ): Promise<ThreadEvent[]> => {
    const entries = (
      await storage.read({
        stream: threadEventsStream(threadId),
        afterSequence: after,
        limit: count,
      })
    ).entries;
    if (
      entries.some(
        ({ createdAt, value }) =>
          createdAt !== at &&
          ['prompt.accepted', 'prompt.started'].includes(
            (value as ThreadEventEnvelope).type,
          ),
      )
    )
      await fixTimes(threadId, entries, at);
    return entries.map(toThreadEvent);
  };

  const fixTimes = (
    threadId: string,
    entries: readonly StreamEntry[],
    at: string,
  ): Promise<void> =>
    threads.mutateNow(threadId, (current) => {
      if (current === undefined) return { done: () => undefined };
      const stored = current.value;
      const timeOf = new Map(
        entries.map((entry) => [entry.sequence, entry.createdAt]),
      );
      const started = [...entries]
        .reverse()
        .find(
          (entry) =>
            (entry.value as ThreadEventEnvelope).type === 'prompt.started',
        );
      const lastStarted =
        started !== undefined &&
        stored.lastStarted !== null &&
        stored.lastStarted.at === at &&
        stored.lastStarted.promptId ===
          (started.value as ThreadEventEnvelope).promptId
          ? { ...stored.lastStarted, at: started.createdAt }
          : stored.lastStarted;
      let changed = lastStarted !== stored.lastStarted;
      const pending = stored.pending?.map((prompt) => {
        const time = timeOf.get(prompt.acceptedSequence);
        if (time === undefined || prompt.acceptedAt !== at) return prompt;
        changed = true;
        return { ...prompt, acceptedAt: time };
      });
      if (!changed) return { done: () => undefined };
      return {
        value: { ...stored, lastStarted, pending: pending ?? null },
        done: () => undefined,
      };
    });

  /** Appends events to one Thread in one commit and answers them in order. */
  const append = (
    id: string,
    events: readonly Pending[],
  ): Promise<ThreadEvent[]> =>
    threads.mutate(id, async (current, attempt) => {
      if (current === undefined)
        throw new Error('Thread to append to was not found.');
      const { base, intervening } = await caughtUp(current.value, attempt);
      const before = base.lastSequence;
      const appended = await applyEvents(base, events);
      return {
        value: appended.value,
        batch: {
          append: [
            {
              stream: threadEventsStream(id),
              expectedSequence: before,
              events: [...appended.envelopes],
            },
          ],
        },
        done: async () => {
          publishIntervening(intervening);
          return await appendedEvents(id, before, events.length, appended.at);
        },
      };
    });

  /** A rename, directory change or result: missing answers undefined. */
  const update = (id: string, change: Partial<ThreadDocument>) =>
    threads.mutate(id, (current) => {
      if (current === undefined) return { done: () => undefined };
      const value = touched(current.value, change);
      return { value, done: () => toThread(value) };
    });

  /** The Threads of a Project, oldest first. */
  const ofProject = async (projectId: string) =>
    (
      await queryAll(storage, {
        type: threadType.type,
        index: 'byProject',
        equals: [projectId],
      })
    ).map(({ value, revision }) => ({
      value: value as ThreadDocument,
      revision,
    }));

  /** A Thread and its descendants, the Thread first then level by level. */
  const subtreeOf = (
    root: string,
    members: readonly Cached<ThreadDocument>[],
  ): Cached<ThreadDocument>[] => {
    const children = new Map<string, Cached<ThreadDocument>[]>();
    for (const member of members) {
      const parent = member.value.parentThreadId;
      if (parent === null) continue;
      children.set(parent, [...(children.get(parent) ?? []), member]);
    }
    const first = members.find(({ value }) => value.id === root);
    if (first === undefined) return [];
    const ordered = [first];
    for (let index = 0; index < ordered.length; index += 1)
      ordered.push(...(children.get(ordered[index]?.value.id ?? '') ?? []));
    return ordered;
  };

  /** The open Threads, or the named one when it is open. */
  const openThreads = async (id?: string): Promise<ThreadDocument[]> => {
    if (id !== undefined) {
      const stored = await threads.get(id);
      return stored !== undefined && isOpenState(stored.value.state)
        ? [stored.value]
        : [];
    }
    return (
      await queryAll(storage, {
        type: threadType.type,
        index: 'byOpen',
        equals: [true],
      })
    ).map(({ value }) => value as ThreadDocument);
  };

  /**
   * Every prompt the log accepted without a `prompt.finished` counterpart,
   * over the given Threads, in the order the log accepted them (sequence,
   * then Thread id, as the former cross-Thread read ordered its rows).
   */
  const unfinished = async (
    open: readonly ThreadDocument[],
  ): Promise<PromptProgress[]> => {
    const rows = (
      await Promise.all(
        open.map(async (stored) =>
          (
            await pendingOf(stored)
          ).map((pending) => ({
            threadId: stored.id,
            pending,
            progress: toProgress(stored.projectId, stored.id, pending),
          })),
        ),
      )
    ).flat();
    return rows
      .sort(
        (a, b) =>
          a.pending.acceptedSequence - b.pending.acceptedSequence ||
          (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0),
      )
      .map(({ progress }) => progress);
  };

  const store: ThreadStore = {
    catchUp: (id) =>
      threads.mutate(id, async (current) => {
        if (current === undefined) return { done: () => undefined };
        // `caughtUp` reads past the document only on a retry; here the read
        // is the point, so ask as a retry does.
        const { base, intervening } = await caughtUp(current.value, 1);
        if (intervening.length === 0) return { done: () => undefined };
        return {
          value: base,
          done: () => publishIntervening(intervening),
        };
      }),

    appendEvents: async (id, promptId, values) =>
      append(id, prepare(promptId, values)),

    appendEvent: async (id, promptId, value) => {
      const [event] = await append(id, prepare(promptId, [value]));
      if (event === undefined)
        throw new Error('The appended event was not read back.');
      return event;
    },

    async queue(id) {
      // One consistent read: the Thread, then its Project's names, again if
      // the Thread moved in between (the former RepeatableRead transaction).
      for (;;) {
        const stored = await threads.get(id);
        if (stored === undefined) return undefined;
        const pending = await pendingOf(stored.value);
        const related = await ofProject(stored.value.projectId);
        const again = await threads.get(id);
        if (again?.revision !== stored.revision) continue;
        return queueSnapshot(
          toThread(stored.value),
          pending.map((prompt) =>
            toProgress(stored.value.projectId, id, prompt),
          ),
          new Map(related.map(({ value }) => [value.id, value.name])),
        );
      }
    },

    async usage(id) {
      const stored = await threads.get(id);
      if (stored === undefined) return undefined;
      const subtree = subtreeOf(id, await ofProject(stored.value.projectId));
      const rows: SubtreeUsage[] = await Promise.all(
        subtree.map(async ({ value }) => ({
          threadId: value.id,
          name: value.name,
          parentThreadId: value.parentThreadId,
          state: await usageOf(value),
        })),
      );
      return threadUsage(rows);
    },

    create(projectId, name, parentThreadId, inherit, origin) {
      const id = randomUUID();
      return projects.mutate(projectId, async (owner) => {
        if (
          owner === undefined ||
          (owner.value.state !== 'queued' && owner.value.state !== 'ready')
        )
          throw new Error('Inactive project.');
        const ancestors: Cached<ThreadDocument>[] = [];
        let next: string | null = parentThreadId ?? null;
        while (next !== null) {
          const ancestor = await threads.get(next);
          if (ancestor === undefined || ancestor.value.projectId !== projectId)
            throw new Error('Invalid parent thread.');
          ancestors.push(ancestor);
          next = ancestor.value.parentThreadId;
        }
        if (
          ancestors.some(({ value }) =>
            ['cancelling', 'failed', 'cancelled'].includes(value.state),
          )
        )
          throw new Error('Invalid parent thread.');
        const at = now();
        const value: ThreadDocument = {
          id,
          projectId,
          parentThreadId: parentThreadId ?? null,
          ...(origin === undefined ? {} : { origin }),
          name,
          state: 'queued',
          open: true,
          cwd: inherit?.cwd ?? '/workspace',
          cwdRepo: inherit === undefined ? null : (inherit.cwdRepo ?? null),
          queuePaused: false,
          activePromptId: null,
          errorCode: null,
          lastSequence: 0,
          result: null,
          lastStarted: null,
          usage: null,
          pending: [],
          createdAt: at,
          updatedAt: at,
          startedAt: null,
          finishedAt: null,
          createdKey: createdKey(at, id),
        };
        return {
          batch: {
            expect: [
              { type: threadType.type, id, revision: 0 },
              ...ancestors.map(({ value: ancestor, revision }) => ({
                type: threadType.type,
                id: ancestor.id,
                revision,
              })),
            ],
            put: [{ type: threadType.type, id, value }],
          },
          done: () => ({ thread: toThread(value) }),
        };
      });
    },

    async find(id) {
      const stored = await threads.get(id);
      return stored === undefined
        ? undefined
        : { thread: toThread(stored.value) };
    },

    async record(id) {
      const stored = await threads.get(id);
      return stored === undefined ? undefined : toThread(stored.value);
    },

    async list(projectId, limit, cursor, parentThreadId) {
      checkLimit(limit);
      const anchor =
        cursor === undefined ? undefined : await threads.get(cursor);
      if (
        cursor !== undefined &&
        (anchor === undefined ||
          anchor.value.projectId !== projectId ||
          (parentThreadId !== undefined &&
            anchor.value.parentThreadId !== parentThreadId))
      )
        return { items: [] };
      const records = await queryAll(
        storage,
        {
          type: threadType.type,
          ...(parentThreadId === undefined
            ? { index: 'byProject', equals: [projectId] }
            : { index: 'byParent', equals: [projectId, parentThreadId] }),
          order: 'desc',
          ...(anchor === undefined
            ? {}
            : { range: { lt: anchor.value.createdKey } }),
        },
        limit + 1,
      );
      return page(
        records.map(({ value }) => toThread(value as ThreadDocument)),
        limit,
      );
    },

    async listByProject(projectId) {
      return (await ofProject(projectId)).map(({ value }) => toThread(value));
    },

    rename: (id, name) => update(id, { name }),

    // The directory and its hint are one write: a hint can never describe a
    // directory the Thread is no longer in.
    setCwd: (id, cwd, cwdRepo) => update(id, { cwd, cwdRepo: cwdRepo ?? null }),

    setState: (id, state, activePromptId, errorCode) =>
      threads.mutate(id, (current) => {
        if (current === undefined) return { done: () => undefined };
        if (excludedStates(state).includes(current.value.state))
          return { done: () => toThread(current.value) };
        const at = now();
        const value = touched(current.value, {
          state: state as ThreadState,
          activePromptId: state === 'running' ? (activePromptId ?? null) : null,
          errorCode: errorCode ?? null,
          ...(state === 'ready' && current.value.startedAt === null
            ? { startedAt: at }
            : {}),
          ...(state === 'failed' || state === 'cancelled'
            ? { finishedAt: at }
            : {}),
        });
        return { value, done: () => toThread(value) };
      }),

    reopen: (id) =>
      threads.mutate(id, (current) => {
        if (current === undefined) return { done: () => undefined };
        if (current.value.state !== 'failed')
          return { done: () => toThread(current.value) };
        const at = now();
        const value = touched(current.value, {
          state: 'ready',
          activePromptId: null,
          errorCode: null,
          finishedAt: null,
          ...(current.value.startedAt === null ? { startedAt: at } : {}),
        });
        return { value, done: () => toThread(value) };
      }),

    history: (id) => historyReader(storage, id),

    saveHistory: (id, patch) =>
      threads.mutate(id, (current) => {
        if (current === undefined)
          throw new Error('Thread to save history for was not found.');
        return {
          value: touched(current.value, {}),
          batch: {
            put: historyPuts(id, current.value.projectId, patch),
          },
          done: () => undefined,
        };
      }),

    // The checkpoint write never moved `updatedAt` (it was raw SQL), and it
    // wrote nothing for a missing Thread.
    saveCheckpoint: (id, patch) =>
      threads.mutate(id, (current) =>
        current === undefined || Object.keys(patch.parts).length === 0
          ? { done: () => undefined }
          : {
              batch: {
                put: historyPuts(id, current.value.projectId, patch),
              },
              done: () => undefined,
            },
      ),

    rewind: (id, promptId) =>
      threads.mutate(id, async (current) => {
        if (current === undefined) return { done: () => undefined };
        const stored = current.value;
        const entries = await all()(id);
        const from = entries.find(
          (entry) => (entry.value as ThreadEventEnvelope).promptId === promptId,
        )?.sequence;
        if (from === undefined) return { done: () => undefined };
        const removed = [
          ...new Set(
            entries
              .filter(({ sequence }) => sequence >= from)
              .map(({ value }) => (value as ThreadEventEnvelope).promptId),
          ),
        ];
        const patch = await options.executor.rewind({
          projectId: stored.projectId,
          threadId: id,
          history: await historyReader(storage, id),
          promptId,
          removedPromptIds: removed,
        });
        if (patch === undefined) return { done: () => undefined };
        const survivors = entries.filter(({ sequence }) => sequence < from);
        const afterSequence = survivors.at(-1)?.sequence ?? 0;
        const previous = await usageOf(stored);
        const retained = foldUsage(
          survivors.map(({ value }) => ({
            type: (value as ThreadEventEnvelope).type,
            event: (value as ThreadEventEnvelope).event,
          })),
        );
        const started = [...survivors]
          .reverse()
          .find(
            ({ value }) =>
              (value as ThreadEventEnvelope).type === 'prompt.started',
          );
        const marker = { type: 'history.truncated', afterSequence };
        const lastStreamSequence =
          entries.at(-1)?.sequence ?? stored.lastSequence;
        const sequence = lastStreamSequence + 1;
        const at = now();
        const pending = foldProgress(foldAll(survivors.map(progressEntry)), {
          sequence,
          promptId,
          type: marker.type,
          event: marker,
          createdAt: at,
        });
        const value = touched(stored, {
          lastSequence: sequence,
          usage: storableJson(rewoundUsage(previous, retained)),
          lastStarted:
            started === undefined
              ? null
              : {
                  promptId: (started.value as ThreadEventEnvelope).promptId,
                  at: started.createdAt,
                },
          pending: [...pending],
        });
        return {
          value,
          batch: {
            truncate: {
              stream: threadEventsStream(id),
              afterSequence: from - 1,
            },
            append: [
              {
                stream: threadEventsStream(id),
                expectedSequence: lastStreamSequence,
                events: [
                  {
                    projectId: stored.projectId,
                    threadId: id,
                    promptId,
                    type: marker.type,
                    event: marker,
                  } satisfies ThreadEventEnvelope,
                ],
              },
            ],
            put: historyPuts(id, stored.projectId, patch),
          },
          done: async () =>
            (await appendedEvents(id, lastStreamSequence, 1, at))[0],
        };
      }),

    eventsAfter: (id, sequence) => eventsAfter(storage, id, sequence),

    eventsAfterPage: (id, sequence, limit) =>
      eventsAfterPage(storage, id, sequence, limit),

    async setResult(id, result) {
      await update(id, {
        result: {
          status: result.status,
          text: storable(result.text),
          promptId: result.promptId,
          at: new Date(result.at).toISOString(),
        },
      });
    },

    async unfinishedPrompts(id) {
      return unfinished(await openThreads(id));
    },

    async lastPrompt(id) {
      const entries = await entriesAfter(storage, id, 0);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const value = entries[index]?.value as ThreadEventEnvelope | undefined;
        if (value?.type !== 'prompt.accepted') continue;
        const event = value.event as
          | { readonly text?: unknown; readonly source?: unknown }
          | null
          | undefined;
        const text = event?.text;
        if (typeof text !== 'string' || text.trim().length === 0) continue;
        const source = inputSourceSchema.safeParse(event?.source);
        return {
          text,
          source: source.success ? source.data : { kind: 'user' as const },
        };
      }
      return undefined;
    },

    failPrompt: (prompt, failure) =>
      threads.mutate(prompt.threadId, async (current, attempt) => {
        if (current === undefined) return { done: () => undefined };
        // Idempotent: a prompt already closed is no longer pending.
        if (
          !(await pendingOf(current.value)).some(
            ({ promptId }) => promptId === prompt.promptId,
          )
        )
          return { done: () => undefined };
        const { base, intervening } = await caughtUp(current.value, attempt);
        const child = await applyEvents(
          base,
          prepare(prompt.promptId, [
            { type: 'agent.failed', error: failure },
            {
              type: 'prompt.finished',
              status: 'failed',
              text: 'The prompt failed.',
              source: prompt.source,
            },
          ]),
        );
        const value: ThreadDocument = {
          ...child.value,
          result: {
            status: 'failed',
            text: storable('The prompt failed.'),
            promptId: prompt.promptId,
            at: now(),
          },
        };
        const batch = {
          append: [
            {
              stream: threadEventsStream(prompt.threadId),
              expectedSequence: base.lastSequence,
              events: [...child.envelopes],
            },
          ],
        };
        const childDone = async () => {
          publishIntervening(intervening);
          await appendedEvents(
            prompt.threadId,
            base.lastSequence,
            child.envelopes.length,
            child.at,
          );
        };
        if (prompt.source.kind !== 'parent')
          return { value, batch, done: async () => void (await childDone()) };
        const parent = await threads.get(prompt.source.threadId);
        if (
          parent === undefined ||
          parent.value.projectId !== prompt.projectId ||
          isTerminalState(parent.value.state) ||
          parent.value.state === 'cancelling'
        )
          return { value, batch, done: async () => void (await childDone()) };
        const parentId = parent.value.id;
        const { base: parentBase, intervening: parentIntervening } =
          await caughtUp(parent.value, attempt);
        const resultId = randomUUID();
        const delivered = await applyEvents(
          parentBase,
          prepare(resultId, [
            {
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
            },
            { type: 'prompt.queued' },
          ]),
        );
        return {
          value,
          batch: {
            expect: [
              {
                type: threadType.type,
                id: parentId,
                revision: parent.revision,
              },
            ],
            put: [
              { type: threadType.type, id: parentId, value: delivered.value },
            ],
            append: [
              ...batch.append,
              {
                stream: threadEventsStream(parentId),
                expectedSequence: parentBase.lastSequence,
                events: [...delivered.envelopes],
              },
            ],
          },
          touches: [parentId],
          done: async () => {
            await childDone();
            publishIntervening(parentIntervening);
            await appendedEvents(
              parentId,
              parentBase.lastSequence,
              delivered.envelopes.length,
              delivered.at,
            );
          },
        };
      }),

    deleteSubtree: (id) =>
      threads.mutate(id, async (current) => {
        if (current === undefined) return { done: () => 'missing' as const };
        const subtree = subtreeOf(id, await ofProject(current.value.projectId));
        if (subtree.length === 0) return { done: () => 'missing' as const };
        if (subtree.some(({ value }) => !isTerminalState(value.state)))
          return { done: () => 'active' as const };
        const parts = (
          await Promise.all(
            subtree.map(({ value }) => historyParts(storage, value.id)),
          )
        ).flat();
        const images = await attachments.records({
          threadIds: subtree.map(({ value }) => value.id),
        });
        return {
          batch: {
            expect: subtree
              .filter(({ value }) => value.id !== id)
              .map(({ value, revision }) => ({
                type: threadType.type,
                id: value.id,
                revision,
              })),
            delete: [
              ...subtree.map(({ value }) => ({
                type: threadType.type,
                id: value.id,
              })),
              ...parts,
              ...images.keys,
            ],
            dropStreams: subtree.map(({ value }) =>
              threadEventsStream(value.id),
            ),
          },
          done: async () => {
            await collect(attachments, images.ids);
            return 'deleted' as const;
          },
        };
      }),

    async reconcile(include) {
      // A host that restarted resumes its Threads rather than failing them,
      // and its Threads stay resumable too: a prompt whose run started but
      // never recorded a pause was interrupted by the restart itself, so the
      // reboot records that reason and leaves the prompt unfinished for the
      // boot to take up. It returns how many Threads the resume pass moved
      // to `ready`; a termination completed here is not counted.
      const open = await openThreads();
      const live =
        include === undefined
          ? open
          : open.filter((thread) => include(thread.projectId));
      for (const prompt of await unfinished(live))
        if (prompt.started && prompt.paused === undefined)
          await store.appendEvent(prompt.threadId, prompt.promptId, {
            type: 'prompt.paused',
            reason: 'host_restarted',
          });
      let resumed = 0;
      for (const { id } of live) {
        const moved = await threads.mutate(id, (current) => {
          if (current === undefined || isTerminalState(current.value.state))
            return { done: () => false };
          const stored = current.value;
          const at = now();
          // A resumed record carries no stale error; a storage pause keeps its.
          const clears =
            stored.errorCode !== null && stored.errorCode !== 'storage_low';
          // CANCELLING is a user's termination: complete it, do not revive it.
          const change: Partial<ThreadDocument> =
            stored.state === 'cancelling'
              ? { state: 'cancelled', activePromptId: null, finishedAt: at }
              : stored.state === 'ready'
                ? {}
                : { state: 'ready', activePromptId: null };
          if (!clears && Object.keys(change).length === 0)
            return { done: () => false };
          return {
            value: touched(stored, {
              ...change,
              ...(clears ? { errorCode: null } : {}),
            }),
            done: () => change.state === 'ready',
          };
        });
        if (moved) resumed += 1;
      }
      return resumed;
    },
  };

  return store;
};
