// The codec of `papercraft`'s host part as a process (phase 3, S57): the
// routed `papercraft.programs/v1` messages to and from today's domain shapes,
// and the hook inputs to the four fields the library entry reads.

import { type MessageInitShape, toJson } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import type {
  OnPromptStartedHookInput,
  OnThreadCwdChangedHookInput,
} from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import type { z } from 'zod';

import {
  type ExportRequest,
  ExportRequestSchema,
  type ExportResponseSchema,
  type LibraryRequest,
  LibraryRequestSchema,
  type LibraryResponseSchema,
  type ReadRequest,
  ReadRequestSchema,
  type ReadResponseSchema,
} from '../contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import {
  type ExportAnswer,
  exportInputSchema,
  type LibraryAnswer,
  libraryInputSchema,
  type ModuleRef,
  readInputSchema,
} from '../contracts/programs.js';
import type { CwdChangedFields, PromptStartedFields } from './library.js';
import type { ModuleFileBytes } from './programs.js';

/** The largest `Read` item's `bytes` (1 MiB). */
const READ_CHUNK_BYTES = 1_048_576;

/** `json` parsed with `schema`; a refusal is `invalid_input` naming the method. */
const parsed = <T>(schema: z.ZodType<T>, json: unknown, method: string): T => {
  const result = schema.safeParse(json);

  if (!result.success) {
    throw new ContractError(
      'invalid_input',
      `Invalid input for papercraft.programs/v1 ${method}.`,
      { issues: result.error.issues },
    );
  }

  return result.data;
};

/**
 * Request decoders: `toJson(Schema, request)` parsed with today's schema; throw
 * `ContractError('invalid_input', 'Invalid input for papercraft.programs/v1 <Method>.', {issues})` on a refusal.
 */
export const libraryInputOf = (
  request: LibraryRequest,
): { readonly turnSequence: number } =>
  parsed(
    libraryInputSchema,
    toJson(LibraryRequestSchema, request, { alwaysEmitImplicit: true }),
    'Library',
  );
export const exportInputOf = (
  request: ExportRequest,
): { readonly path: string; readonly name?: string } =>
  parsed(
    exportInputSchema,
    toJson(ExportRequestSchema, request, { alwaysEmitImplicit: true }),
    'Export',
  );
export const readInputOf = (request: ReadRequest): { readonly dir: string } =>
  parsed(
    readInputSchema,
    toJson(ReadRequestSchema, request, { alwaysEmitImplicit: true }),
    'Read',
  );

/** A domain `ModuleRef` as its message init. */
const moduleOf = (module: ModuleRef) => ({
  dir: module.dir,
  files: module.files.map(({ path, sha256 }) => ({ path, sha256 })),
});

/** Domain answer → message init: `{status: {case, value}}`; `none` → `{case: 'none', value: {}}`. Never throws. */
export const libraryResponseOf = (
  answer: LibraryAnswer,
): MessageInitShape<typeof LibraryResponseSchema> => {
  switch (answer.status) {
    case 'none':
      return { status: { case: 'none', value: {} } };
    case 'ready':
      return {
        status: {
          case: 'ready',
          value: { root: answer.root, module: moduleOf(answer.module) },
        },
      };
    case 'failed':
      return {
        status: {
          case: 'failed',
          value: {
            ...(answer.root === undefined ? {} : { root: answer.root }),
            error: answer.error,
          },
        },
      };
  }
};
export const exportResponseOf = (
  answer: ExportAnswer,
): MessageInitShape<typeof ExportResponseSchema> =>
  answer.status === 'ready'
    ? { status: { case: 'ready', value: { module: moduleOf(answer.module) } } }
    : { status: { case: 'failed', value: { error: answer.error } } };

/**
 * `Read`'s items for `files`, in order: each file in ≤ 1 MiB chunks `{path, sha256, offset, bytes}` with increasing
 * offsets whose concatenation is the file; an empty file is one item with empty `bytes` at offset 0. Pure.
 */
export const readItemsOf = (
  files: readonly ModuleFileBytes[],
): Iterable<MessageInitShape<typeof ReadResponseSchema>> => ({
  *[Symbol.iterator]() {
    for (const { path, sha256, bytes } of files) {
      let offset = 0;

      do {
        yield {
          path,
          sha256,
          offset,
          bytes: bytes.subarray(offset, offset + READ_CHUNK_BYTES),
        };
        offset += READ_CHUNK_BYTES;
      } while (offset < bytes.length);
    }
  },
});

/** Hook inputs as the library entry reads them (four fields; `promptId` absent stays absent). Never throw. */
export const promptStartedOf = (
  input: OnPromptStartedHookInput,
): PromptStartedFields => ({
  projectId: input.projectId,
  threadId: input.threadId,
  promptId: input.promptId,
  cwd: input.cwd,
});
export const cwdChangedOf = (
  input: OnThreadCwdChangedHookInput,
): CwdChangedFields => ({
  projectId: input.projectId,
  threadId: input.threadId,
  ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
  cwd: input.cwd,
});
