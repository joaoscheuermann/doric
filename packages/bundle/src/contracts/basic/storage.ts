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

// Shapes for stage 2/3 providers; they may be refined before a provider
// publishes a baseline, and every refinement is recorded in the decisions.

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
    limit: z.number().int().positive(),
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
    afterSequence: z.number().int(),
    limit: z.number().int().positive(),
  })
  .strict();

export const streamEntrySchema = z
  .object({ sequence: z.number().int(), value: z.unknown() })
  .strict();

export const streamPageSchema = z
  .object({
    entries: z.array(streamEntrySchema),
    lastSequence: z.number().int(),
  })
  .strict();

export type StreamPage = z.output<typeof streamPageSchema>;

export const commitBatchSchema = z
  .object({
    expect: z
      .array(documentKey.extend({ revision: z.number().int() }))
      .optional(),
    put: z.array(documentKey.extend({ value: z.unknown() })).optional(),
    delete: z.array(documentKey).optional(),
    append: z
      .array(
        z
          .object({
            stream: z.string(),
            expectedSequence: z.number().int().optional(),
            events: z.array(z.unknown()),
          })
          .strict(),
      )
      .optional(),
    truncate: z
      .object({ stream: z.string(), afterSequence: z.number().int() })
      .strict()
      .optional(),
  })
  .strict();

export type CommitBatch = z.output<typeof commitBatchSchema>;

export const commitResultSchema = z
  .object({ position: z.number().int() })
  .strict();

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
}

export const StorageV1 = ref<Storage>('storage/v1');

export const storageMethods = {
  defineType: { input: storageTypeDefinitionSchema, output: disposableSchema },
  get: { input: documentKey, output: storedDocumentSchema.optional() },
  query: { input: storageQuerySchema, output: storagePageSchema },
  read: { input: streamReadSchema, output: streamPageSchema },
  commit: { input: commitBatchSchema, output: commitResultSchema },
} as const satisfies MethodSpecs;

export const storageHealthSchema = z
  .object({
    status: z.enum(['ok', 'pressure', 'unavailable']),
    writable: z.boolean(),
    reason: z.string().optional(),
  })
  .strict();

export type StorageHealth = z.output<typeof storageHealthSchema>;

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
          streams: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export type FeedPage = z.output<typeof feedPageSchema>;

const declareTypeSchema = z
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

export interface StorageBackend {
  declareType(
    declaration: z.input<typeof declareTypeSchema>,
    call?: CallArg,
  ): Promise<void>;
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
  putBlob(bytes: string, call?: CallArg): Promise<{ hash: string }>;
  getBlob(hash: string, call?: CallArg): Promise<string | undefined>;
  capabilities(call?: CallArg): Promise<StorageCapabilities>;
  health(call?: CallArg): Promise<StorageHealth>;
}

export const StorageBackendV1 = ref<StorageBackend>('storage.backend/v1');

export const storageBackendMethods = {
  declareType: { input: declareTypeSchema, output: z.void() },
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
  capabilities: { input: noInput, output: storageCapabilitiesSchema },
  health: { input: noInput, output: storageHealthSchema },
} as const satisfies MethodSpecs;
