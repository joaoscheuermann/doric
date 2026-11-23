// What `storage.backend/v1` and `storage/v1` share on the wire: their
// request and answer messages differ only by name, their items are the same
// `doric.storage.v1.*` messages. Not exported by `storage/rpc`.

import {
  type DescMessage,
  fromJson,
  type Message,
  type MessageInitShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Value, ValueSchema } from '@bufbuild/protobuf/wkt';
import {
  type CommitBatch,
  ContractError,
  type StorageHealth,
  type StoragePage,
  type StorageQuery,
  type StoredDocument,
  type StreamPage,
} from 'bundle/contracts';
import type {
  CommitRequest,
  CommitRequestSchema,
  GetBlobResponse,
  GetBlobResponseSchema,
  GetResponse,
  GetResponseSchema,
  QueryResponse,
  QueryResponseSchema,
  ReadResponse,
  ReadResponseSchema,
  StorageHealth as WireHealth,
  StorageHealthSchema as WireHealthSchema,
  StorageQuery as WireQuery,
  StorageQuerySchema as WireQuerySchema,
  StorageRange,
} from 'bundle/contracts/gen/doric/storage/v1/storage_pb.js';

import { chunkBytes, decodeJson, encodeJson, joinChunks } from './chunks.js';

/**
 * The plain-object init of a message: assignable to the init of every
 * message with the same fields, whatever its name.
 */
type Init<D extends DescMessage> = Exclude<MessageInitShape<D>, Message>;

/** An item of a request or answer stream: its `item` oneof. */
interface Itemized<T extends { readonly item: unknown }> {
  readonly item: T['item'];
}

/** An index value of a query: what `StorageQuery.equals` and its range hold. */
type IndexValue = StorageQuery['equals'][number];

/** The range bounds of a query, in the order the proto lists them. */
const bounds = ['gt', 'gte', 'lt', 'lte'] as const;

/** Storage indexes as both sides send them: `unique` only when set. */
export const indexesOf = (
  indexes: readonly {
    readonly name: string;
    readonly fields: readonly string[];
    readonly unique?: boolean;
  }[],
) =>
  indexes.map(({ name, fields, unique }) => ({
    name,
    fields: [...fields],
    ...(unique === undefined ? {} : { unique }),
  }));

/** The base64 `putBlob` accepts: the memory backend's canonical check. */
export const isBase64 = (value: string): boolean =>
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

/** The query a `QueryRequest`'s `storage_query` describes. */
export const queryOf = (query: WireQuery): StorageQuery => {
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

/** The `storage_query` of a `QueryRequest` for `query`. */
export const wireQueryOf = (query: StorageQuery): Init<typeof WireQuerySchema> => {
  const range = query.range;

  return {
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
  };
};

/** A malformed request stream: `invalid_input`, and the provider is not called. */
const malformedRequest = (message: string): ContractError =>
  new ContractError('invalid_input', message);

/** A malformed answer stream: `invalid_output`. */
export const malformedAnswer = (message: string): ContractError =>
  new ContractError('invalid_output', message);

/**
 * The `CommitBatch` a `Commit` request stream describes, read to its end.
 * Throws `invalid_input` for a malformed stream: a `chunk` that follows no
 * `put` or `event`, a `put` with no chunk, an `append` with no `event`, a
 * second `truncate`, or a value whose chunks are not UTF-8 JSON text.
 */
export const commitBatchOf = async (
  requests: AsyncIterable<Itemized<CommitRequest>>,
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
export const commitItemsOf = (batch: CommitBatch): Init<typeof CommitRequestSchema>[] => {
  const items: Init<typeof CommitRequestSchema>[] = [];
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

/** The bytes a `PutBlob` request stream holds, as base64. */
export const blobOf = async (
  requests: AsyncIterable<{ readonly chunk: Uint8Array }>,
): Promise<string> => {
  const chunks: Uint8Array[] = [];

  for await (const { chunk } of requests) {
    chunks.push(chunk);
  }

  return Buffer.from(joinChunks(chunks)).toString('base64');
};

/** The `PutBlob` request items of the base64 `bytes`; `invalid_input` if not base64. */
export const blobItemsOf = (bytes: string): { chunk: Uint8Array }[] => {
  if (!isBase64(bytes)) {
    throw new ContractError('invalid_input', 'The blob is not base64.');
  }

  return chunkBytes(Buffer.from(bytes, 'base64')).map((chunk) => ({ chunk }));
};

// Answers, served -------------------------------------------------------------

/** The `Get` answer for `document`: its item and its value's chunks, or none. */
export function* documentAnswer(
  document: StoredDocument | undefined,
): Generator<Init<typeof GetResponseSchema>> {
  if (document === undefined) {
    return;
  }

  const { type, id, revision } = document;

  yield { item: { case: 'document', value: { type, id, revision } } };

  for (const chunk of encodeJson(document.value)) {
    yield { item: { case: 'chunk', value: chunk } };
  }
}

/** The `Query` answer for `page`: its head, then each document and its chunks. */
export function* queryAnswer(page: StoragePage): Generator<Init<typeof QueryResponseSchema>> {
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
}

/** The `Read` answer for `page`: its head, then each entry and its chunks. */
export function* readAnswer(page: StreamPage): Generator<Init<typeof ReadResponseSchema>> {
  yield {
    item: {
      case: 'page',
      value: {
        lastSequence: page.lastSequence,
        truncations: page.truncations.map(({ afterSequence, atSequence }) => ({
          afterSequence,
          atSequence,
        })),
      },
    },
  };

  for (const { sequence, createdAt, value } of page.entries) {
    yield { item: { case: 'entry', value: { sequence, createdAt } } };

    for (const chunk of encodeJson(value)) {
      yield { item: { case: 'chunk', value: chunk } };
    }
  }
}

/** The `GetBlob` answer for the base64 `blob`: its head, then its chunks. */
export function* blobAnswer(
  blob: string | undefined,
): Generator<Init<typeof GetBlobResponseSchema>> {
  yield { item: { case: 'head', value: { found: blob !== undefined } } };

  if (blob === undefined) {
    return;
  }

  for (const chunk of chunkBytes(Buffer.from(blob, 'base64'))) {
    yield { item: { case: 'chunk', value: chunk } };
  }
}

/** The wire `StorageHealth` of `health`, absent fields absent. */
export const wireHealthOf = ({
  status,
  writable,
  reason,
  disk,
}: StorageHealth): Init<typeof WireHealthSchema> => ({
  status,
  writable,
  ...(reason === undefined ? {} : { reason }),
  ...(disk === undefined
    ? {}
    : { disk: { blocks: disk.blocks, availableBlocks: disk.availableBlocks } }),
});

// Answers, read ---------------------------------------------------------------

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

/** The document a `Get` answer holds, `undefined` when it held no item. */
export const readDocument = async (
  answer: AsyncIterable<Itemized<GetResponse>>,
): Promise<StoredDocument | undefined> => {
  const documents: Chunked<{ type: string; id: string; revision: number }>[] =
    [];

  for await (const { item } of answer) {
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
    : { ...document.head, value: decodeJson(document.chunks, 'invalid_output') };
};

/** The page a `Query` answer holds. */
export const readQueryPage = async (
  answer: AsyncIterable<Itemized<QueryResponse>>,
): Promise<StoragePage> => {
  let cursor: string | undefined;
  let headed = false;
  const documents: Chunked<{ type: string; id: string; revision: number }>[] =
    [];

  for await (const { item } of answer) {
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
};

/** The page a `Read` answer holds. */
export const readStreamPage = async (
  answer: AsyncIterable<Itemized<ReadResponse>>,
): Promise<StreamPage> => {
  let page: Omit<StreamPage, 'entries'> | undefined;
  const entries: Chunked<{ sequence: number; createdAt: string }>[] = [];

  for await (const { item } of answer) {
    if (page === undefined) {
      if (item.case !== 'page') {
        throw malformedAnswer('Read answered no page first.');
      }

      page = {
        lastSequence: item.value.lastSequence,
        truncations: item.value.truncations.map(
          ({ afterSequence, atSequence }) => ({ afterSequence, atSequence }),
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
};

/** The base64 blob a `GetBlob` answer holds, `undefined` for `found: false`. */
export const readBlob = async (
  answer: AsyncIterable<Itemized<GetBlobResponse>>,
): Promise<string | undefined> => {
  let found: boolean | undefined;
  const chunks: Uint8Array[] = [];

  for await (const { item } of answer) {
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

  return found ? Buffer.from(joinChunks(chunks)).toString('base64') : undefined;
};

/** The `StorageHealth` a `Health` answer holds. */
export const healthOf = (health: WireHealth | undefined): StorageHealth => {
  if (health === undefined) {
    throw malformedAnswer('Health answered no storage_health.');
  }

  const { status, writable, reason, disk } = health;

  if (status !== 'ok' && status !== 'unavailable') {
    throw malformedAnswer(`Health answered the status ${status}.`);
  }

  return {
    status,
    writable,
    ...(reason === undefined ? {} : { reason }),
    ...(disk === undefined
      ? {}
      : { disk: { blocks: disk.blocks, availableBlocks: disk.availableBlocks } }),
  };
};
