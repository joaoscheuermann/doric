// `storage.backend/v1` between a `StorageBackend` and the router (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4"):
// `postgres` serves its backend with `serveStorageBackend`, `core` calls it
// with `storageBackendClient`, and the tests serve the memory backend the
// same way. Phase 4 deletes this file with the contract.

import { fromJson, type MessageInitShape, toJson } from '@bufbuild/protobuf';
import { type Value, ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import {
  type CommitBatch,
  ContractError,
  type StorageBackend,
  type StorageQuery,
} from 'bundle/contracts';
import type {
  CommitRequest,
  CommitRequestSchema,
  BackendService as StorageBackendService,
} from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';
import type {
  StorageRange,
  StorageQuery as WireQuery,
} from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';

import { backendCallOf, calling, connectOptionsOf } from './call.js';
import { chunkBytes, decodeJson, encodeJson, joinChunks } from './chunks.js';

/** An index value of a query: what `StorageQuery.equals` and its range hold. */
type IndexValue = StorageQuery['equals'][number];

/** The range bounds of a query, in the order the proto lists them. */
const bounds = ['gt', 'gte', 'lt', 'lte'] as const;

/** The base64 `putBlob` accepts: the memory backend's canonical check. */
const isBase64 = (value: string): boolean =>
  value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

/** The index value a request's `google.protobuf.Value` holds. */
const indexValueOf = (value: Value): IndexValue => {
  const json = toJson(ValueSchema, value);

  if (typeof json === 'object' && json !== null) {
    throw new ContractError(
      'invalid_input',
      'An index value is a string, a number, a boolean or null.',
    );
  }

  return json;
};

/** The query a `QueryRequest`'s `storage_query` describes. */
const queryOf = (query: WireQuery): StorageQuery => {
  const { order, cursor, range } = query;

  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw new ContractError('invalid_input', 'order is asc or desc.');
  }

  return {
    type: query.type,
    index: query.index,
    equals: query.equals.map(indexValueOf),
    limit: query.limit,
    ...(range === undefined ? {} : { range: rangeOf(range) }),
    ...(order === undefined ? {} : { order }),
    ...(cursor === undefined ? {} : { cursor }),
  };
};

/** The range a request's `StorageRange` describes, absent bounds omitted. */
const rangeOf = (range: StorageRange): NonNullable<StorageQuery['range']> => {
  const result: NonNullable<StorageQuery['range']> = {};

  for (const bound of bounds) {
    const value = range[bound];

    if (value !== undefined) {
      result[bound] = indexValueOf(value);
    }
  }

  return result;
};

/** A malformed request stream: `invalid_input`, and the backend is not called. */
const malformedRequest = (message: string): ContractError =>
  new ContractError('invalid_input', message);

/** A malformed answer stream: `invalid_output`. */
const malformedAnswer = (message: string): ContractError =>
  new ContractError('invalid_output', message);

/**
 * The `CommitBatch` a `Commit` request stream describes, read to its end.
 * Throws `invalid_input` for a malformed stream (see `serveStorageBackend`).
 */
const commitBatchOf = async (
  requests: AsyncIterable<CommitRequest>,
): Promise<CommitBatch> => {
  const expect: NonNullable<CommitBatch['expect']> = [];
  const puts: { type: string; id: string; chunks: Uint8Array[] }[] = [];
  const deletes: NonNullable<CommitBatch['delete']> = [];
  const dropStreams: string[] = [];
  const appends: {
    stream: string;
    expectedSequence: number | undefined;
    events: Uint8Array[][];
  }[] = [];
  let truncate: CommitBatch['truncate'];
  // The chunks a `chunk` item extends: the last put's or the last event's.
  let open: Uint8Array[] | undefined;
  // The append an `event` item belongs to.
  let append: (typeof appends)[number] | undefined;

  for await (const { item } of requests) {
    if (item.case === 'chunk') {
      if (open === undefined) {
        throw malformedRequest('A chunk follows no put and no event.');
      }

      open.push(item.value);
      continue;
    }

    if (item.case === 'event') {
      if (append === undefined) {
        throw malformedRequest('An event follows no append.');
      }

      open = [item.value];
      append.events.push(open);
      continue;
    }

    open = undefined;
    append = undefined;

    switch (item.case) {
      case 'expect':
        expect.push({
          type: item.value.type,
          id: item.value.id,
          revision: item.value.revision,
        });
        break;
      case 'put':
        open = [];
        puts.push({ type: item.value.type, id: item.value.id, chunks: open });
        break;
      case 'delete':
        deletes.push({ type: item.value.type, id: item.value.id });
        break;
      case 'dropStream':
        dropStreams.push(item.value);
        break;
      case 'truncate':
        if (truncate !== undefined) {
          throw malformedRequest('A commit holds at most one truncate.');
        }

        truncate = {
          stream: item.value.stream,
          afterSequence: item.value.afterSequence,
        };
        break;
      case 'append':
        append = {
          stream: item.value.stream,
          expectedSequence: item.value.expectedSequence,
          events: [],
        };
        appends.push(append);
        break;
      default:
        throw malformedRequest('A commit item holds nothing.');
    }
  }

  for (const put of puts) {
    if (put.chunks.length === 0) {
      throw malformedRequest(`The put of ${put.type}/${put.id} has no chunk.`);
    }
  }

  for (const entry of appends) {
    if (entry.events.length === 0) {
      throw malformedRequest(`The append to ${entry.stream} has no event.`);
    }
  }

  const put = puts.map(({ type, id, chunks }) => ({
    type,
    id,
    value: decodeJson(chunks, 'invalid_input'),
  }));
  const append_ = appends.map(({ stream, expectedSequence, events }) => ({
    stream,
    ...(expectedSequence === undefined ? {} : { expectedSequence }),
    events: events.map((chunks) => decodeJson(chunks, 'invalid_input')),
  }));

  return {
    ...(expect.length === 0 ? {} : { expect }),
    ...(put.length === 0 ? {} : { put }),
    ...(deletes.length === 0 ? {} : { delete: deletes }),
    ...(dropStreams.length === 0 ? {} : { dropStreams }),
    ...(truncate === undefined ? {} : { truncate }),
    ...(append_.length === 0 ? {} : { append: append_ }),
  };
};

/** The `Commit` request items of `batch`, in the fixed wire order. */
const commitItemsOf = (
  batch: CommitBatch,
): MessageInitShape<typeof CommitRequestSchema>[] => {
  const items: MessageInitShape<typeof CommitRequestSchema>[] = [];
  const chunks = (value: unknown) => {
    for (const chunk of encodeJson(value)) {
      items.push({ item: { case: 'chunk', value: chunk } });
    }
  };

  for (const { type, id, revision } of batch.expect ?? []) {
    items.push({ item: { case: 'expect', value: { type, id, revision } } });
  }

  for (const { type, id, value } of batch.put ?? []) {
    items.push({ item: { case: 'put', value: { type, id } } });
    chunks(value);
  }

  for (const { type, id } of batch.delete ?? []) {
    items.push({ item: { case: 'delete', value: { type, id } } });
  }

  for (const stream of batch.dropStreams ?? []) {
    items.push({ item: { case: 'dropStream', value: stream } });
  }

  if (batch.truncate !== undefined) {
    const { stream, afterSequence } = batch.truncate;

    items.push({ item: { case: 'truncate', value: { stream, afterSequence } } });
  }

  for (const { stream, expectedSequence, events } of batch.append ?? []) {
    items.push({
      item: {
        case: 'append',
        value: {
          stream,
          ...(expectedSequence === undefined ? {} : { expectedSequence }),
        },
      },
    });

    for (const event of events) {
      encodeJson(event).forEach((chunk, index) => {
        items.push(
          index === 0
            ? { item: { case: 'event', value: chunk } }
            : { item: { case: 'chunk', value: chunk } },
        );
      });
    }
  }

  return items;
};

/** One item of an answer stream and the chunks of its value. */
interface Chunked<T> {
  readonly head: T;
  readonly chunks: Uint8Array[];
}

/** Adds `chunk` to the last of `items`; `invalid_output` when there is none. */
const addChunk = (items: Chunked<unknown>[], chunk: Uint8Array): void => {
  const last = items.at(-1);

  if (last === undefined) {
    throw malformedAnswer('A chunk came before any item.');
  }

  last.chunks.push(chunk);
};

/**
 * The implementation of `doric.storage.backend.v1.BackendService` over
 * `backend`, for a `services` entry
 * `[StorageBackendService, serveStorageBackend(backend)]` of `runBundle` or
 * `createTestRouter().activate`.
 *
 * Each RPC calls the matching `backend` method once, with the handler's
 * `callOf(context)` as its `call` argument, and answers in the wire shape of
 * section 17 (see the RPC table of the S36 contracts): `Get` answers the
 * document's item, then its value's chunks, or no item when `backend.get`
 * answers `undefined`; `Query` and `Read` answer the page's head first, then
 * one item per document or entry, each followed by its value's chunks;
 * `GetBlob` answers `head { found }` first, then, when found, the bytes in
 * chunks (none for an empty blob); `Feed` answers one item per commit of the
 * page, in order; `Commit` reads the whole request stream, rebuilds one
 * `CommitBatch` and calls `backend.commit` once, after the stream ended.
 * Every chunk is non-empty and at most 1 MiB; fields `backend` leaves absent
 * stay absent on the wire.
 *
 * Fails a call with what `backend` threw, unchanged when it is a
 * `ContractError` (code, message and details reach the caller), as
 * `internal` otherwise (the SDK's rule). Before calling `backend`, fails it
 * with `ContractError` `invalid_input` and applies nothing when a request
 * stream is malformed: in `Commit`, a `chunk` that follows no `put` or
 * `event`, a `put` with no chunk, an `append` with no `event`, a second
 * `truncate`, or a value whose chunks are not UTF-8 JSON text; in `PutBlob`,
 * nothing else (zero chunks are the empty blob). Never calls `backend` for a
 * request the router refused. Holds no state between calls: the instance
 * may be served by several routers at once.
 */
export const serveStorageBackend = (
  backend: StorageBackend,
): ServiceImpl<typeof StorageBackendService> => ({
  declareType: async ({ type, indexes }, context) => {
    await backend.declareType(
      {
        type,
        indexes: indexes.map(({ name, fields, unique }) => ({
          name,
          fields: [...fields],
          ...(unique === undefined ? {} : { unique }),
        })),
      },
      backendCallOf(context),
    );

    return {};
  },
  async *get({ type, id }, context) {
    const document = await backend.get({ type, id }, backendCallOf(context));

    if (document === undefined) {
      return;
    }

    yield {
      item: {
        case: 'document',
        value: {
          type: document.type,
          id: document.id,
          revision: document.revision,
        },
      },
    };

    for (const chunk of encodeJson(document.value)) {
      yield { item: { case: 'chunk', value: chunk } };
    }
  },
  async *query({ storageQuery }, context) {
    if (storageQuery === undefined) {
      throw new ContractError('invalid_input', 'storageQuery is required.');
    }

    const page = await backend.query(
      queryOf(storageQuery),
      backendCallOf(context),
    );

    yield {
      item: {
        case: 'page',
        value: page.cursor === undefined ? {} : { cursor: page.cursor },
      },
    };

    for (const { type, id, revision, value } of page.items) {
      yield { item: { case: 'document', value: { type, id, revision } } };

      for (const chunk of encodeJson(value)) {
        yield { item: { case: 'chunk', value: chunk } };
      }
    }
  },
  async *read({ streamRead }, context) {
    if (streamRead === undefined) {
      throw new ContractError('invalid_input', 'streamRead is required.');
    }

    const page = await backend.read(
      {
        stream: streamRead.stream,
        afterSequence: streamRead.afterSequence,
        limit: streamRead.limit,
      },
      backendCallOf(context),
    );

    yield {
      item: {
        case: 'page',
        value: {
          lastSequence: page.lastSequence,
          truncations: page.truncations.map(
            ({ afterSequence, atSequence }) => ({ afterSequence, atSequence }),
          ),
        },
      },
    };

    for (const { sequence, createdAt, value } of page.entries) {
      yield { item: { case: 'entry', value: { sequence, createdAt } } };

      for (const chunk of encodeJson(value)) {
        yield { item: { case: 'chunk', value: chunk } };
      }
    }
  },
  commit: async (requests, context) =>
    backend.commit(await commitBatchOf(requests), backendCallOf(context)),
  async *feed({ after, limit }, context) {
    const page = await backend.feed({ after, limit }, backendCallOf(context));

    for (const commit of page.commits) {
      yield {
        position: commit.position,
        documents: commit.documents.map(({ type, id }) => ({ type, id })),
        streams: commit.streams,
        truncated: commit.truncated,
        dropped: commit.dropped,
      };
    }
  },
  putBlob: async (requests, context) => {
    const chunks: Uint8Array[] = [];

    for await (const { chunk } of requests) {
      chunks.push(chunk);
    }

    return backend.putBlob(
      Buffer.from(joinChunks(chunks)).toString('base64'),
      backendCallOf(context),
    );
  },
  async *getBlob({ hash }, context) {
    const blob = await backend.getBlob(hash, backendCallOf(context));

    yield { item: { case: 'head', value: { found: blob !== undefined } } };

    if (blob === undefined) {
      return;
    }

    for (const chunk of chunkBytes(Buffer.from(blob, 'base64'))) {
      yield { item: { case: 'chunk', value: chunk } };
    }
  },
  deleteBlob: async ({ hash }, context) => {
    await backend.deleteBlob(hash, backendCallOf(context));

    return {};
  },
  capabilities: (_request, context) =>
    backend.capabilities(backendCallOf(context)),
  health: async (_request, context) => {
    const { status, writable, reason, disk } = await backend.health(
      backendCallOf(context),
    );

    return {
      storageHealth: {
        status,
        writable,
        ...(reason === undefined ? {} : { reason }),
        ...(disk === undefined
          ? {}
          : {
              disk: {
                blocks: disk.blocks,
                availableBlocks: disk.availableBlocks,
              },
            }),
      },
    };
  },
  identity: async (_request, context) => {
    const { hostId, storageGeneration } = await backend.identity(
      backendCallOf(context),
    );

    return { storageIdentity: { hostId, storageGeneration } };
  },
  connect: async (_request, context) => {
    await backend.connect(backendCallOf(context));

    return {};
  },
});

/**
 * A `StorageBackend` that calls `doric.storage.backend.v1.BackendService`
 * through `client` (`context.services.use(StorageBackendService)`, or
 * `createTestRouter().client(StorageBackendService)`), so a caller written
 * against `StorageBackend` (`core`'s facade, the conformance kit) works
 * unchanged over the router.
 *
 * Each method makes one call and resolves with today's shape: absent fields
 * are omitted, never present as `undefined`; `get` answers `undefined` when
 * the stream held no item; `query`/`read` answer the head's `cursor` /
 * `lastSequence` and `truncations` with every item and its decoded value;
 * `feed` answers `{ commits }` with one entry per item; `getBlob` answers
 * `undefined` for `found: false` and the base64 of the chunks' bytes
 * otherwise (`''` for an empty blob); `putBlob` decodes the base64 and sends
 * its bytes in chunks; `commit` sends one item per batch entry — `expect`,
 * `put` each followed by its value's chunks, `delete`, `drop_stream`,
 * `truncate`, `append` each followed by one `event` per event (the first
 * chunk) and `chunk` items with the rest — and answers `{ position }`.
 * `declareType`, `deleteBlob` and `connect` resolve with `undefined`.
 *
 * `call`: a `Call` or `CallOptions` aborts the call when its `signal`
 * aborts and ends it at its deadline (`deadlineOf(call)` or
 * `options.deadline`; 0 or absent is none). Inside a handler of the host
 * SDK, scope and trace also follow `currentCall()`, as for any client.
 *
 * Rejects with a `ContractError`: the provider's error as
 * `fromConnectError` reads it (code, message, details), so
 * `revision_conflict`, `sequence_conflict`, `unique_conflict`,
 * `limit_exceeded`, `unknown_type`, `invalid_index_value`,
 * `invalid_stream`, `invalid_input` and the transport's `unavailable`,
 * `cancelled` and `deadline_exceeded` reach the caller as `isContractError`
 * values; `invalid_input` without any call when `putBlob`'s argument is not
 * canonical base64 (the memory backend's check: length a multiple of 4,
 * `[A-Za-z0-9+/]*={0,2}`) or a `put` value or event cannot be
 * `JSON.stringify`d; `invalid_output` when an answer breaks the wire shape
 * (a `chunk` before any item, a second `document` in `Get`, no head first in
 * `Query`, `Read` or `GetBlob`, chunks after `found: false`, a value that is
 * not UTF-8 JSON). Never throws synchronously. Does no zod validation of its
 * arguments: the provider validates (protovalidate at the router, the
 * backend's own checks).
 */
export const storageBackendClient = (
  client: Client<typeof StorageBackendService>,
): StorageBackend => ({
  declareType: (declaration, call) =>
    calling(async () => {
      await client.declareType(
        {
          type: declaration.type,
          indexes: declaration.indexes.map(({ name, fields, unique }) => ({
            name,
            fields: [...fields],
            ...(unique === undefined ? {} : { unique }),
          })),
        },
        connectOptionsOf(call),
      );
    }),
  get: (key, call) =>
    calling(async () => {
      const documents: Chunked<{
        type: string;
        id: string;
        revision: number;
      }>[] = [];

      for await (const { item } of client.get(
        { type: key.type, id: key.id },
        connectOptionsOf(call),
      )) {
        if (item.case === 'document') {
          if (documents.length > 0) {
            throw malformedAnswer('Get answered a second document.');
          }

          const { type, id, revision } = item.value;

          documents.push({ head: { type, id, revision }, chunks: [] });
        } else if (item.case === 'chunk') {
          addChunk(documents, item.value);
        } else {
          throw malformedAnswer('Get answered an empty item.');
        }
      }

      const [document] = documents;

      return document === undefined
        ? undefined
        : {
            ...document.head,
            value: decodeJson(document.chunks, 'invalid_output'),
          };
    }),
  query: (query, call) =>
    calling(async () => {
      const range = query.range;
      let cursor: string | undefined;
      let headed = false;
      const documents: Chunked<{
        type: string;
        id: string;
        revision: number;
      }>[] = [];

      for await (const { item } of client.query(
        {
          storageQuery: {
            type: query.type,
            index: query.index,
            equals: query.equals.map((value) => fromJson(ValueSchema, value)),
            limit: query.limit,
            ...(range === undefined
              ? {}
              : {
                  range: Object.fromEntries(
                    bounds.flatMap((bound) => {
                      const value = range[bound];

                      return value === undefined
                        ? []
                        : [[bound, fromJson(ValueSchema, value)]];
                    }),
                  ),
                }),
            ...(query.order === undefined ? {} : { order: query.order }),
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          },
        },
        connectOptionsOf(call),
      )) {
        if (!headed) {
          if (item.case !== 'page') {
            throw malformedAnswer('Query answered no page first.');
          }

          headed = true;
          cursor = item.value.cursor;
        } else if (item.case === 'document') {
          const { type, id, revision } = item.value;

          documents.push({ head: { type, id, revision }, chunks: [] });
        } else if (item.case === 'chunk') {
          addChunk(documents, item.value);
        } else {
          throw malformedAnswer('Query answered a second page.');
        }
      }

      if (!headed) {
        throw malformedAnswer('Query answered no page.');
      }

      return {
        items: documents.map(({ head, chunks }) => ({
          ...head,
          value: decodeJson(chunks, 'invalid_output'),
        })),
        ...(cursor === undefined ? {} : { cursor }),
      };
    }),
  read: (request, call) =>
    calling(async () => {
      let page:
        | {
            lastSequence: number;
            truncations: { afterSequence: number; atSequence: number }[];
          }
        | undefined;
      const entries: Chunked<{ sequence: number; createdAt: string }>[] = [];

      for await (const { item } of client.read(
        {
          streamRead: {
            stream: request.stream,
            afterSequence: request.afterSequence,
            limit: request.limit,
          },
        },
        connectOptionsOf(call),
      )) {
        if (page === undefined) {
          if (item.case !== 'page') {
            throw malformedAnswer('Read answered no page first.');
          }

          page = {
            lastSequence: item.value.lastSequence,
            truncations: item.value.truncations.map(
              ({ afterSequence, atSequence }) => ({
                afterSequence,
                atSequence,
              }),
            ),
          };
        } else if (item.case === 'entry') {
          const { sequence, createdAt } = item.value;

          entries.push({ head: { sequence, createdAt }, chunks: [] });
        } else if (item.case === 'chunk') {
          addChunk(entries, item.value);
        } else {
          throw malformedAnswer('Read answered a second page.');
        }
      }

      if (page === undefined) {
        throw malformedAnswer('Read answered no page.');
      }

      return {
        entries: entries.map(({ head, chunks }) => ({
          sequence: head.sequence,
          value: decodeJson(chunks, 'invalid_output'),
          createdAt: head.createdAt,
        })),
        lastSequence: page.lastSequence,
        truncations: page.truncations,
      };
    }),
  commit: (batch, call) =>
    calling(async () => {
      const items = commitItemsOf(batch);
      const { position } = await client.commit(
        createAsyncIterable(items),
        connectOptionsOf(call),
      );

      return { position };
    }),
  feed: (request, call) =>
    calling(async () => {
      const commits: Awaited<ReturnType<StorageBackend['feed']>>['commits'] =
        [];

      for await (const commit of client.feed(
        { after: request.after, limit: request.limit },
        connectOptionsOf(call),
      )) {
        commits.push({
          position: commit.position,
          documents: commit.documents.map(({ type, id }) => ({ type, id })),
          streams: [...commit.streams],
          truncated: [...commit.truncated],
          dropped: [...commit.dropped],
        });
      }

      return { commits };
    }),
  putBlob: (bytes, call) =>
    calling(async () => {
      if (!isBase64(bytes)) {
        throw new ContractError('invalid_input', 'The blob is not base64.');
      }

      const chunks = chunkBytes(Buffer.from(bytes, 'base64'));
      const { hash } = await client.putBlob(
        createAsyncIterable(chunks.map((chunk) => ({ chunk }))),
        connectOptionsOf(call),
      );

      return { hash };
    }),
  getBlob: (hash, call) =>
    calling(async () => {
      let found: boolean | undefined;
      const chunks: Uint8Array[] = [];

      for await (const { item } of client.getBlob(
        { hash },
        connectOptionsOf(call),
      )) {
        if (found === undefined) {
          if (item.case !== 'head') {
            throw malformedAnswer('GetBlob answered no head first.');
          }

          found = item.value.found;
        } else if (item.case === 'chunk' && found) {
          chunks.push(item.value);
        } else {
          throw malformedAnswer(
            found
              ? 'GetBlob answered a second head.'
              : 'GetBlob answered chunks after found: false.',
          );
        }
      }

      if (found === undefined) {
        throw malformedAnswer('GetBlob answered no head.');
      }

      return found
        ? Buffer.from(joinChunks(chunks)).toString('base64')
        : undefined;
    }),
  deleteBlob: (hash, call) =>
    calling(async () => {
      await client.deleteBlob({ hash }, connectOptionsOf(call));
    }),
  capabilities: (call) =>
    calling(async () => {
      const { maxBatch, maxDocumentBytes, maxAppendBytes } =
        await client.capabilities({}, connectOptionsOf(call));

      return { maxBatch, maxDocumentBytes, maxAppendBytes };
    }),
  health: (call) =>
    calling(async () => {
      const { storageHealth } = await client.health(
        {},
        connectOptionsOf(call),
      );

      if (storageHealth === undefined) {
        throw malformedAnswer('Health answered no storage_health.');
      }

      const { status, writable, reason, disk } = storageHealth;

      if (status !== 'ok' && status !== 'unavailable') {
        throw malformedAnswer(`Health answered the status ${status}.`);
      }

      return {
        status,
        writable,
        ...(reason === undefined ? {} : { reason }),
        ...(disk === undefined
          ? {}
          : {
              disk: {
                blocks: disk.blocks,
                availableBlocks: disk.availableBlocks,
              },
            }),
      };
    }),
  identity: (call) =>
    calling(async () => {
      const { storageIdentity } = await client.identity(
        {},
        connectOptionsOf(call),
      );

      if (storageIdentity === undefined) {
        throw malformedAnswer('Identity answered no storage_identity.');
      }

      const { hostId, storageGeneration } = storageIdentity;

      return { hostId, storageGeneration };
    }),
  connect: (call) =>
    calling(async () => {
      await client.connect({}, connectOptionsOf(call));
    }),
});
