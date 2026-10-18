import { defineStorageType } from 'bundle/contracts';
import { z } from 'zod';

import {
  attachmentIdSchema,
  attachmentMediaTypeSchema,
} from './attachments.js';
import { inputSourceSchema } from './model.js';
import { runtimeOwnerSchema } from './runtime.js';

/*
 * The runtime's documents and streams on storage/v1 (design 57 §3.1, §3.2 as
 * revised). Exported so `postgres` and the stage-7 migration check against
 * the same schemas. `createdKey` is `createdAt + '|' + id`: one sortable
 * field that expresses today's (createdAt, id) order and id cursor.
 */

const iso = z.string();

/** `createdAt + '|' + id`, the single sortable field of the list indexes. */
export const createdKey = (createdAt: string, id: string): string =>
  `${createdAt}|${id}`;

export const projectDocumentSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** Any stored text; readers expose palette values only. */
    color: z.string().nullable(),
    state: z.enum(['queued', 'ready', 'cancelling', 'cancelled', 'failed']),
    open: z.boolean(),
    configRevision: z.number().int(),
    /** The full configuration at create, verbatim, never read for execution. */
    configSnapshot: z.unknown(),
    errorCode: z.string().nullable(),
    createdAt: iso,
    updatedAt: iso,
    startedAt: iso.nullable(),
    finishedAt: iso.nullable(),
    createdKey: z.string(),
    /**
     * The runtime process holding the Project live (57-WP-H): internal, the
     * public record never shows it. Absent or null when no process does.
     */
    owner: runtimeOwnerSchema.nullable().optional(),
  })
  .strict();

export type ProjectDocument = z.output<typeof projectDocumentSchema>;

/** One unfinished prompt: PromptProgress plus the fold's bookkeeping. */
export const pendingPromptSchema = z
  .object({
    promptId: z.string(),
    text: z.string(),
    revision: z.number().int().optional(),
    source: inputSourceSchema,
    started: z.boolean(),
    paused: z
      .enum(['host_stopped', 'host_restarted', 'reader_stopped', 'storage_low'])
      .optional(),
    superseded: z.boolean().optional(),
    attempts: z.number().int(),
    acceptedAt: iso.optional(),
    /** Cross-Thread boot order: (acceptedSequence, threadId) ascending. */
    acceptedSequence: z.number().int(),
    queuedSequence: z.number().int().optional(),
    pausedSequence: z.number().int().optional(),
    first: z.boolean().optional(),
    /** The prompt this steering input waits to be taken into. */
    steer: z.string().optional(),
  })
  .strict();

export type PendingPrompt = z.output<typeof pendingPromptSchema>;

export const threadDocumentSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    parentThreadId: z.uuid().nullable(),
    name: z.string(),
    state: z.enum([
      'queued',
      'ready',
      'running',
      'cancelling',
      'cancelled',
      'failed',
    ]),
    open: z.boolean(),
    /** Default '/workspace'. */
    cwd: z.string(),
    cwdRepo: z.enum(['git', 'github']).nullable(),
    queuePaused: z.boolean(),
    activePromptId: z.uuid().nullable(),
    errorCode: z.string().nullable(),
    /** Equals the event stream's counter. */
    lastSequence: z.number().int(),
    result: z
      .object({
        status: z.string(),
        text: z.string(),
        promptId: z.uuid(),
        at: iso,
      })
      .strict()
      .nullable(),
    /** The latest prompt.started. */
    lastStarted: z.object({ promptId: z.uuid(), at: iso }).strict().nullable(),
    /** The usage state; null derives it lazily from the events. */
    usage: z.unknown().nullable(),
    /** null folds it lazily from the stream (stage-7 rows). */
    pending: z.array(pendingPromptSchema).nullable(),
    createdAt: iso,
    updatedAt: iso,
    startedAt: iso.nullable(),
    finishedAt: iso.nullable(),
    createdKey: z.string(),
  })
  .strict();

export type ThreadDocument = z.output<typeof threadDocumentSchema>;

/** One opaque executor history part; the document id is `<threadId>:<part>`. */
export const historyDocumentSchema = z
  .object({
    threadId: z.uuid(),
    projectId: z.uuid(),
    /** For example 'direct.history/v1'. */
    format: z.string(),
    part: z.string(),
    value: z.unknown(),
  })
  .strict();

export type HistoryDocument = z.output<typeof historyDocumentSchema>;

export const historyDocumentId = (threadId: string, part: string): string =>
  `${threadId}:${part}`;

export const migrationDocumentSchema = z
  .object({
    source: z.literal('prisma-legacy'),
    completedAt: iso,
    counts: z
      .object({
        projects: z.number(),
        threads: z.number(),
        events: z.number(),
        histories: z.number(),
      })
      .strict(),
  })
  .strict();

export type MigrationDocument = z.output<typeof migrationDocumentSchema>;

/** The id of the one migration marker document. */
export const migrationDocumentId = 'legacy-prisma';

export const projectType = defineStorageType({
  type: 'runtime.project/v1',
  schema: projectDocumentSchema,
  indexes: [
    { name: 'byCreated', fields: ['createdKey'] },
    { name: 'byOpen', fields: ['open', 'createdKey'] },
  ],
});

export const threadType = defineStorageType({
  type: 'runtime.thread/v1',
  schema: threadDocumentSchema,
  indexes: [
    { name: 'byProject', fields: ['projectId', 'createdKey'] },
    { name: 'byParent', fields: ['projectId', 'parentThreadId', 'createdKey'] },
    { name: 'byOpen', fields: ['open', 'createdKey'] },
  ],
});

export const historyType = defineStorageType({
  type: 'runtime.history/v1',
  schema: historyDocumentSchema,
  indexes: [{ name: 'byThread', fields: ['threadId'] }],
});

/**
 * One image a Thread attached; the id is `<threadId>:<attachment id>`. The
 * bytes are the blob the attachment id names. The record is what lets the
 * Thread's Project read it, and what keeps the blob: deleting the Thread or
 * its Project deletes the record, and a blob no record names any more is
 * deleted after it.
 */
export const attachmentDocumentSchema = z
  .object({
    projectId: z.uuid(),
    threadId: z.uuid(),
    id: attachmentIdSchema,
    name: z.string(),
    mediaType: attachmentMediaTypeSchema,
    size: z.number().int().positive(),
    createdAt: iso,
  })
  .strict();

export type AttachmentDocument = z.output<typeof attachmentDocumentSchema>;

export const attachmentDocumentId = (
  threadId: string,
  attachmentId: string,
): string => `${threadId}:${attachmentId}`;

export const attachmentType = defineStorageType({
  type: 'runtime.attachment/v1',
  schema: attachmentDocumentSchema,
  indexes: [
    { name: 'byProject', fields: ['projectId', 'id'] },
    { name: 'byThread', fields: ['threadId'] },
    { name: 'byBlob', fields: ['id'] },
  ],
});

export const migrationType = defineStorageType({
  type: 'runtime.migration/v1',
  schema: migrationDocumentSchema,
  indexes: [],
});

/** The prefix of every Thread's event stream. */
export const threadEventsStreamPrefix = 'runtime.thread.events/';

export const threadEventsStream = (threadId: string): string =>
  `${threadEventsStreamPrefix}${threadId}`;

/** The Thread a stream of `threadEventsStream` names, else undefined. */
export const threadIdOfStream = (stream: string): string | undefined => {
  if (!stream.startsWith(threadEventsStreamPrefix)) return undefined;
  const threadId = stream.slice(threadEventsStreamPrefix.length);
  return threadId === '' || threadId.includes('/') ? undefined : threadId;
};

/**
 * The value of each entry of a Thread's event stream: the Project, Thread and
 * prompt it belongs to, its durable `type` and its body. The sequence and
 * `createdAt` are the protocol entry's, never part of the value. The keys are
 * the runtime's: the event sink of the runtime names them (see
 * `threadEventSink`), and the core writes the row in that order.
 */
export const threadEventEnvelopeSchema = z
  .object({
    projectId: z.string(),
    threadId: z.string(),
    promptId: z.string(),
    type: z.string(),
    event: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ThreadEventEnvelope = z.output<typeof threadEventEnvelopeSchema>;

export const threadStreamEntrySchema = threadEventEnvelopeSchema;
