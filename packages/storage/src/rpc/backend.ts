// `storage.backend/v1` between a `StorageBackend` and the router (spec
// `docs/designs/grpc-processes.md`, section 17, "Storage until phase 4"):
// `postgres` serves its backend with `serveStorageBackend`, `core` calls it
// with `storageBackendClient`, and the tests serve the memory backend the
// same way. Phase 4 deletes this file with the contract.

import type { Client, ServiceImpl } from '@connectrpc/connect';
import { createAsyncIterable } from '@connectrpc/connect/protocol';
import { ContractError, type StorageBackend } from 'bundle/contracts';
import type { BackendService as StorageBackendService } from 'bundle/contracts/gen/doric/storage/backend/v1/backend_pb.js';

import { backendCallOf, calling, connectOptionsOf } from './call.js';
import {
  blobAnswer,
  blobItemsOf,
  blobOf,
  commitBatchOf,
  commitItemsOf,
  documentAnswer,
  healthOf,
  indexesOf,
  malformedAnswer,
  queryAnswer,
  queryOf,
  readAnswer,
  readBlob,
  readDocument,
  readQueryPage,
  readStreamPage,
  wireHealthOf,
  wireQueryOf,
} from './wire.js';

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
      { type, indexes: indexesOf(indexes) },
      backendCallOf(context),
    );

    return {};
  },
  async *get({ type, id }, context) {
    yield* documentAnswer(
      await backend.get({ type, id }, backendCallOf(context)),
    );
  },
  async *query({ storageQuery }, context) {
    if (storageQuery === undefined) {
      throw new ContractError('invalid_input', 'storageQuery is required.');
    }

    yield* queryAnswer(
      await backend.query(queryOf(storageQuery), backendCallOf(context)),
    );
  },
  async *read({ streamRead }, context) {
    if (streamRead === undefined) {
      throw new ContractError('invalid_input', 'streamRead is required.');
    }

    const { stream, afterSequence, limit } = streamRead;

    yield* readAnswer(
      await backend.read(
        { stream, afterSequence, limit },
        backendCallOf(context),
      ),
    );
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
  putBlob: async (requests, context) =>
    backend.putBlob(await blobOf(requests), backendCallOf(context)),
  async *getBlob({ hash }, context) {
    yield* blobAnswer(await backend.getBlob(hash, backendCallOf(context)));
  },
  deleteBlob: async ({ hash }, context) => {
    await backend.deleteBlob(hash, backendCallOf(context));

    return {};
  },
  capabilities: (_request, context) =>
    backend.capabilities(backendCallOf(context)),
  health: async (_request, context) => ({
    storageHealth: wireHealthOf(await backend.health(backendCallOf(context))),
  }),
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
        { type: declaration.type, indexes: indexesOf(declaration.indexes) },
        connectOptionsOf(call),
      );
    }),
  get: (key, call) =>
    calling(() =>
      readDocument(
        client.get({ type: key.type, id: key.id }, connectOptionsOf(call)),
      ),
    ),
  query: (query, call) =>
    calling(() =>
      readQueryPage(
        client.query(
          { storageQuery: wireQueryOf(query) },
          connectOptionsOf(call),
        ),
      ),
    ),
  read: (request, call) =>
    calling(() =>
      readStreamPage(
        client.read(
          {
            streamRead: {
              stream: request.stream,
              afterSequence: request.afterSequence,
              limit: request.limit,
            },
          },
          connectOptionsOf(call),
        ),
      ),
    ),
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
      const items = blobItemsOf(bytes);
      const { hash } = await client.putBlob(
        createAsyncIterable(items),
        connectOptionsOf(call),
      );

      return { hash };
    }),
  getBlob: (hash, call) =>
    calling(() => readBlob(client.getBlob({ hash }, connectOptionsOf(call)))),
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

      return healthOf(storageHealth);
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
