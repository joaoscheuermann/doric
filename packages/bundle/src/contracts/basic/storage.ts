import { z } from 'zod';

import type { CallArg } from '../call.js';
import type { Disposable } from '../context.js';
import { ref, type StorageTypeDefinition } from '../define.js';
import {
  disposableSchema,
  type MethodSpecs,
  noInput,
  storageTypeDefinitionSchema,
} from './common.js';

// Shapes refined in stages 2/3 before any provider published a baseline
// (decision S-1). Error codes raised by storage/v1 and storage.backend/v1:
//
// - `revision_conflict`: an `expect` entry does not match the stored revision
//   (details `{ type, id, expected, actual }`); nothing of the batch applies.
// - `sequence_conflict`: an append's `expectedSequence` is not the stream's
//   `lastSequence`; nothing of the batch applies.
// - `unique_conflict`: a put violates a unique index; nothing applies.
// - `limit_exceeded`: the batch, a document or an append goes over the
//   backend's `capabilities()`; refused before anything is written.
// - `unknown_type`: storage/v1 was asked about a type nobody defined.
// - `invalid_index_value`: an indexed field holds an object or an array.
// - `invalid_stream`: a stream ID does not follow `<owner>.<family>/<key>`.
// - `invalid_input`: the value fails the type's schema, an empty batch, a
//   read after the stream's `lastSequence`, or a malformed cursor.
// - `not_owner`: storage/v1 refuses a type or stream of another bundle.

const documentKey = z.object({ type: z.string(), id: z.string() }).strict();

export const storedDocumentSchema = z
  .object({
    type: z.string(),
    id: z.string(),
    revision: z.number().int(),
    value: z.unknown(),
  })
  .strict();

export type StoredDocument = z.output<typeof storedDocumentSchema>;

const indexValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const storageQuerySchema = z
  .object({
    type: z.string(),
    index: z.string(),
    equals: z.array(indexValue),
    range: z
      .object({
        gt: indexValue.optional(),
        gte: indexValue.optional(),
        lt: indexValue.optional(),
        lte: indexValue.optional(),
      })
      .strict()
      .optional(),
    order: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().positive().max(1000),
    cursor: z.string().optional(),
  })
  .strict();

export type StorageQuery = z.output<typeof storageQuerySchema>;

export const storagePageSchema = z
  .object({
    items: z.array(storedDocumentSchema),
    cursor: z.string().optional(),
  })
  .strict();

export type StoragePage = z.output<typeof storagePageSchema>;

export const streamReadSchema = z
  .object({
    stream: z.string(),
    afterSequence: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  })
  .strict();

export type StreamRead = z.output<typeof streamReadSchema>;

export const streamEntrySchema = z
  .object({
    sequence: z.number().int().positive(),
    value: z.unknown(),
    /** Protocol timestamp (ISO-8601, milliseconds, UTC), set by the backend at commit. */
    createdAt: z.string(),
  })
  .strict();

export type StreamEntry = z.output<typeof streamEntrySchema>;

export const truncationMarkSchema = z
  .object({
    /** Entries above this sequence were removed. */
    afterSequence: z.number().int().nonnegative(),
    /** The stream's `lastSequence` when the truncation committed. */
    atSequence: z.number().int().nonnegative(),
  })
  .strict();

export type TruncationMark = z.output<typeof truncationMarkSchema>;

export const streamPageSchema = z
  .object({
    entries: z.array(streamEntrySchema),
    /** The stream's counter: it never decreases, even after a truncation. */
    lastSequence: z.number().int().nonnegative(),
    /**
     * The marks with `afterSequence < request.afterSequence <= atSequence`:
     * the truncations that removed entries this reader may already hold.
     */
    truncations: z.array(truncationMarkSchema),
  })
  .strict();

export type StreamPage = z.output<typeof streamPageSchema>;

/** Revision 0 means "must not exist". */
export const expectedRevisionSchema = documentKey.extend({
  revision: z.number().int().nonnegative(),
});

/**
 * One atomic batch. It applies in this order, or not at all:
 * expect → delete → put → dropStreams → truncate → append.
 */
export const commitBatchSchema = z
  .object({
    expect: z.array(expectedRevisionSchema).optional(),
    put: z.array(documentKey.extend({ value: z.unknown() })).optional(),
    delete: z.array(documentKey).optional(),
    truncate: z
      .object({
        stream: z.string(),
        afterSequence: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    append: z
      .array(
        z
          .object({
            stream: z.string(),
            expectedSequence: z.number().int().nonnegative().optional(),
            events: z.array(z.unknown()).min(1),
          })
          .strict(),
      )
      .optional(),
    /** API mínima: removes whole streams, entries and truncation marks. */
    dropStreams: z.array(z.string()).optional(),
  })
  .strict();

export type CommitBatch = z.output<typeof commitBatchSchema>;

export const commitResultSchema = z
  .object({ position: z.number().int() })
  .strict();

/**
 * Measurements only: the low-storage policy belongs to the caller. A disk
 * that cannot be measured is `unavailable` without `disk`.
 */
export const storageHealthSchema = z
  .object({
    status: z.enum(['ok', 'unavailable']),
    writable: z.boolean(),
    reason: z.string().optional(),
    disk: z
      .object({
        blocks: z.number().int().nonnegative(),
        availableBlocks: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type StorageHealth = z.output<typeof storageHealthSchema>;

/** The host's storage identity, kept in a reserved record of the backend. */
export const storageIdentitySchema = z
  .object({
    hostId: z.uuid(),
    storageGeneration: z.number().int().positive(),
  })
  .strict();

export type StorageIdentity = z.output<typeof storageIdentitySchema>;

export interface Storage {
  defineType(definition: StorageTypeDefinition): Disposable;
  get(
    key: { readonly type: string; readonly id: string },
    call?: CallArg,
  ): Promise<StoredDocument | undefined>;
  query(query: StorageQuery, call?: CallArg): Promise<StoragePage>;
  read(
    request: z.input<typeof streamReadSchema>,
    call?: CallArg,
  ): Promise<StreamPage>;
  commit(batch: CommitBatch, call?: CallArg): Promise<{ position: number }>;
  /** API mínima: the backend's measurements for the caller's own policy. */
  health(call?: CallArg): Promise<StorageHealth>;
  /**
   * Base64 bytes in, `sha256:<hex>` out. Blobs are content-addressed and
   * shared by every bundle: who may read one is the caller's own record of it.
   */
  putBlob(bytes: string, call?: CallArg): Promise<{ hash: string }>;
  getBlob(hash: string, call?: CallArg): Promise<string | undefined>;
  /**
   * Removes a blob, for the caller whose records no longer name it; an
   * unknown or malformed hash is a no-op.
   */
  deleteBlob(hash: string, call?: CallArg): Promise<void>;
}

export const StorageV1 = ref<Storage>('storage/v1');

export const storageMethods = {
  defineType: { input: storageTypeDefinitionSchema, output: disposableSchema },
  get: { input: documentKey, output: storedDocumentSchema.optional() },
  query: { input: storageQuerySchema, output: storagePageSchema },
  read: { input: streamReadSchema, output: streamPageSchema },
  commit: { input: commitBatchSchema, output: commitResultSchema },
  health: { input: noInput, output: storageHealthSchema },
  putBlob: {
    input: z.string(),
    output: z.object({ hash: z.string() }).strict(),
  },
  getBlob: { input: z.string(), output: z.string().optional() },
  deleteBlob: { input: z.string(), output: z.void() },
} as const satisfies MethodSpecs;

export const storageCapabilitiesSchema = z
  .object({
    maxBatch: z.number().int().positive(),
    maxDocumentBytes: z.number().int().positive(),
    maxAppendBytes: z.number().int().positive(),
  })
  .strict();

export type StorageCapabilities = z.output<typeof storageCapabilitiesSchema>;

export const feedRequestSchema = z
  .object({ after: z.number().int(), limit: z.number().int().positive() })
  .strict();

export const feedPageSchema = z
  .object({
    commits: z.array(
      z
        .object({
          position: z.number().int(),
          documents: z.array(documentKey),
          /** Streams that received appends. */
          streams: z.array(z.string()),
          /** Streams truncated by the commit. */
          truncated: z.array(z.string()),
          /** Streams removed by the commit. */
          dropped: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export type FeedPage = z.output<typeof feedPageSchema>;

export const storageDeclarationSchema = z
  .object({
    type: z.string(),
    indexes: z.array(
      z
        .object({
          name: z.string(),
          fields: z.array(z.string()),
          unique: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type StorageDeclaration = z.input<typeof storageDeclarationSchema>;

export interface StorageBackend {
  declareType(declaration: StorageDeclaration, call?: CallArg): Promise<void>;
  get(
    key: { readonly type: string; readonly id: string },
    call?: CallArg,
  ): Promise<StoredDocument | undefined>;
  query(query: StorageQuery, call?: CallArg): Promise<StoragePage>;
  read(
    request: z.input<typeof streamReadSchema>,
    call?: CallArg,
  ): Promise<StreamPage>;
  commit(batch: CommitBatch, call?: CallArg): Promise<{ position: number }>;
  feed(
    request: z.input<typeof feedRequestSchema>,
    call?: CallArg,
  ): Promise<FeedPage>;
  /** Base64 bytes in, `sha256:<hex>` out. */
  putBlob(bytes: string, call?: CallArg): Promise<{ hash: string }>;
  getBlob(hash: string, call?: CallArg): Promise<string | undefined>;
  /** 1.1.0: removes a blob; an unknown or malformed hash is a no-op. */
  deleteBlob(hash: string, call?: CallArg): Promise<void>;
  capabilities(call?: CallArg): Promise<StorageCapabilities>;
  health(call?: CallArg): Promise<StorageHealth>;
  /** The reserved metadata record; created by the first call. */
  identity(call?: CallArg): Promise<StorageIdentity>;
  /**
   * Opens the backend's connection once, at the host's start (the core's start
   * step calls it first); a failure fails the host's start.
   */
  connect(call?: CallArg): Promise<void>;
}

export const StorageBackendV1 = ref<StorageBackend>('storage.backend/v1');

export const storageBackendMethods = {
  declareType: { input: storageDeclarationSchema, output: z.void() },
  get: { input: documentKey, output: storedDocumentSchema.optional() },
  query: { input: storageQuerySchema, output: storagePageSchema },
  read: { input: streamReadSchema, output: streamPageSchema },
  commit: { input: commitBatchSchema, output: commitResultSchema },
  feed: { input: feedRequestSchema, output: feedPageSchema },
  /** Base64 bytes, so the method stays JSON-representable. */
  putBlob: {
    input: z.string(),
    output: z.object({ hash: z.string() }).strict(),
  },
  getBlob: { input: z.string(), output: z.string().optional() },
  deleteBlob: { input: z.string(), output: z.void() },
  capabilities: { input: noInput, output: storageCapabilitiesSchema },
  health: { input: noInput, output: storageHealthSchema },
  identity: { input: noInput, output: storageIdentitySchema },
  connect: { input: noInput, output: z.void() },
} as const satisfies MethodSpecs;
