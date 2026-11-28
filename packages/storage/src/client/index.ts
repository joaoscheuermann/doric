/**
 * The `storage/v2` client (spec `docs/designs/grpc-processes.md`, "The
 * TypeScript client", A79): `openStorage`, which a bundle calls in its
 * activation, and `storageOver`, which `storage/testing` shares. The client
 * holds no layout and computes no index key: the engine does both.
 */
import {
  create,
  type DescFile,
  type DescMessage,
  fromJson,
  type Message,
  type MessageInitShape,
  toBinary,
} from '@bufbuild/protobuf';
import {
  FileDescriptorSetSchema,
  type Value,
  ValueSchema,
} from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import { type CallArg, ContractError, closure } from 'bundle/contracts';
import {
  type CommitRequestSchema,
  type GetResponse,
  type QueryResponse,
  StorageService,
} from 'bundle/contracts/gen/doric/storage/v2/storage_pb.js';
import type { HostContext } from 'bundle/host';

import type { IndexScalar } from '../keys.js';
import { clientFailure, connectOptionsOf } from '../rpc/call.js';
import type {
  CommitBatch,
  DocumentKey,
  Storage,
  StorageHealth,
  StoragePage,
  StorageQuery,
  StoredDocument,
  StreamPage,
  StreamRead,
} from './types.js';
import {
  chunksOf,
  type DeclaredMessages,
  decodeValue,
  encodeValue,
  messagesOf,
  type ValueKey,
} from './values.js';
import { changesOf, failed } from './watch.js';

/**
 * The most bytes of a `RegisterRequest`'s `descriptor_set`, 2 MiB; a larger
 * set is `limit_exceeded` with `details.limit` `"descriptorSet"`.
 */
export const descriptorSetBytesLimit = 2_097_152;

/**
 * Opens `storage/v2` for the bundle whose context this is: builds the
 * binary descriptor set of `files` and every file they import (`closure` of
 * `bundle/contracts`), calls `Register` once with it through
 * `context.services.use(StorageService)` (`registerOver`), and answers the
 * `Storage` of `storageOver` on that client. Tracks no registration: a new engine
 * instance learns the declarations from what the store holds, and the
 * bundle's next activation registers again.
 *
 * Rejects, and answers no `Storage`, with `limit_exceeded` (`details.limit`
 * `"descriptorSet"`) when the set exceeds `descriptorSetBytesLimit` bytes,
 * before any call; with `Register`'s refusal as a `ContractError`
 * (`not_owner` for a type or a stream prefix of another namespace,
 * `invalid_input` for a declaration the engine refuses, and a rebuild's
 * `unique_conflict` with `{ type, index, ids }` or `limit_exceeded`); and
 * with `cancelled`, `deadline_exceeded` or `unavailable` as the transport
 * fails. A registration from a lower generation than the highest one
 * registered resolves and changes nothing.
 */
export const openStorage = async (
  context: Pick<HostContext, 'services'>,
  files: readonly DescFile[],
): Promise<Storage> => {
  const client = context.services.use(StorageService);

  await registerOver(client, files);

  return storageOver(client, files);
};

/**
 * Calls `Register` once through `client` with the binary descriptor set of
 * `files` and every file they import, imports first, each once; resolves
 * once the engine answered. Rejects as `openStorage` does, the size check
 * included, before any call. Internal to the package: `openStorage`,
 * `TestEngine.storage` and `TestStorage.reset` share it.
 */
export const registerOver = async (
  client: Client<typeof StorageService>,
  files: readonly DescFile[],
): Promise<void> => {
  const descriptorSet = toBinary(
    FileDescriptorSetSchema,
    create(FileDescriptorSetSchema, {
      file: closure(files).map((file) => file.proto),
    }),
  );

  if (descriptorSet.length > descriptorSetBytesLimit) {
    throw new ContractError(
      'limit_exceeded',
      `The descriptor set is ${descriptorSet.length} bytes; at most ${descriptorSetBytesLimit} are allowed.`,
      { limit: 'descriptorSet' },
    );
  }

  await calling(undefined, () => client.register({ descriptorSet }));
};

/**
 * The `Storage` of `client`, registered or not (`registerOver`): every call
 * goes through `client`, and so carries its transport's caller. Each type
 * and stream prefix maps to the message `files` (and their imports) declare
 * for it, read once here; nothing is called until a method is. Rejects with
 * `ContractError('invalid_input')` when two messages declare one type or
 * one stream prefix. Internal to the package: bundles call `openStorage`.
 */
export const storageOver = (
  client: Client<typeof StorageService>,
  files: readonly DescFile[],
): Promise<Storage> =>
  new Promise((resolve) => resolve(storageOf(client, messagesOf(files))));

/** The `Storage` of `client` over the declared messages of its files. */
const storageOf = (
  client: Client<typeof StorageService>,
  { types, streams }: DeclaredMessages,
): Storage => {
  const typeSchema = (type: string): DescMessage =>
    declared(types, type, `the storage type ${type}`);
  const streamSchema = (stream: string): DescMessage =>
    declared(streams, stream.slice(0, stream.indexOf('/') + 1), stream);

  return {
    get: <M extends Message>(key: DocumentKey, call?: CallArg) =>
      calling(call, async (): Promise<StoredDocument<M> | undefined> => {
        const schema = typeSchema(key.type);
        const items = await collect(client.get(key, connectOptionsOf(call)));

        return documentsOf<M>(schema, items)[0];
      }),
    query: <M extends Message>(query: StorageQuery, call?: CallArg) =>
      calling(call, async (): Promise<StoragePage<M>> => {
        const schema = typeSchema(query.type);
        const { equals, range, ...rest } = query;
        const storageQuery = {
          ...rest,
          equals: equals.map(scalarValue),
          ...(range === undefined
            ? {}
            : {
                range: Object.fromEntries(
                  Object.entries(range).map(([bound, scalar]) => [
                    bound,
                    scalarValue(scalar),
                  ]),
                ),
              }),
        };
        const [first, ...items] = await collect(
          client.query({ storageQuery }, connectOptionsOf(call)),
        );

        return {
          items: documentsOf<M>(schema, items),
          nextCursor:
            first?.item.case === 'page'
              ? (first.item.value.nextCursor ?? null)
              : null,
        };
      }),
    read: <M extends Message>(request: StreamRead, call?: CallArg) =>
      calling(call, async (): Promise<StreamPage<M>> => {
        const schema = streamSchema(request.stream);
        const items = await collect(
          client.read({ streamRead: request }, connectOptionsOf(call)),
        );
        const [page] = items.flatMap(({ item }) =>
          item.case === 'page' ? [item.value] : [],
        );
        const entries: {
          sequence: number;
          createdAt: string;
          chunks: Uint8Array[];
        }[] = [];

        for (const { item } of items) {
          if (item.case === 'entry') {
            const { sequence, createdAt } = item.value;

            entries.push({ sequence, createdAt, chunks: [] });
          } else if (item.case === 'chunk') {
            entries.at(-1)?.chunks.push(item.value);
          }
        }

        return {
          entries: entries.map(({ sequence, createdAt, chunks }) => ({
            sequence,
            createdAt,
            value: decodeValue<M>(schema, chunks, { stream: request.stream }),
          })),
          lastSequence: page?.lastSequence ?? 0,
          truncations: (page?.truncations ?? []).map(
            ({ afterSequence, atSequence }) => ({ afterSequence, atSequence }),
          ),
        };
      }),
    commit: (batch, call) =>
      calling(call, async () => {
        const items = commitItems(typeSchema, streamSchema, batch);
        const { position } = await client.commit(
          asyncOf(items),
          connectOptionsOf(call),
        );

        return { position };
      }),
    health: (call) =>
      calling(call, async (): Promise<StorageHealth> => {
        const { storageHealth } = await client.health(
          {},
          connectOptionsOf(call),
        );
        const disk = storageHealth?.disk;

        return {
          status: storageHealth?.status === 'ok' ? 'ok' : 'unavailable',
          writable: storageHealth?.writable ?? false,
          ...(storageHealth?.reason === undefined
            ? {}
            : { reason: storageHealth.reason }),
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
    putBlob: (bytes, call) =>
      calling(call, async () => {
        const { hash } = await client.putBlob(
          blobChunks(bytes),
          connectOptionsOf(call),
        );

        return { hash };
      }),
    getBlob: (hash, call) =>
      calling(call, async () => {
        const [head, ...rest] = await collect(
          client.getBlob({ hash }, connectOptionsOf(call)),
        );

        if (head?.item.case !== 'head' || !head.item.value.found) {
          return undefined;
        }

        return asyncOf(
          rest.flatMap(({ item }) =>
            item.case === 'chunk' ? [item.value] : [],
          ),
        );
      }),
    deleteBlob: (hash, call) =>
      calling(call, async () => {
        await client.deleteBlob({ hash }, connectOptionsOf(call));
      }),
    watch: (request, call) => {
      const types = [...(request.types ?? [])];
      const streams = [...(request.streams ?? [])];

      try {
        types.forEach(typeSchema);
        streams.forEach(streamSchema);
      } catch (error) {
        return failed(error);
      }

      return changesOf(
        client.watch({ types, streams }, connectOptionsOf(call)),
        call,
      );
    },
  };
};

/**
 * Runs `run`, a call made for `call`: a `ConnectError` it fails with rejects
 * as its `ContractError` (`clientFailure`), any other error as it is.
 */
const calling = async <T>(
  call: CallArg | undefined,
  run: () => Promise<T>,
): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw error instanceof ConnectError ? clientFailure(error, call) : error;
  }
};

/** Every message of the server stream `answer`, in order. */
const collect = async <T>(answer: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];

  for await (const item of answer) {
    out.push(item);
  }

  return out;
};

/** `items` as an async iterable. */
async function* asyncOf<T>(items: Iterable<T>): AsyncIterable<T> {
  yield* items;
}

/** The message `found` declares for `name`; `invalid_input` when none does. */
const declared = (
  found: ReadonlyMap<string, DescMessage>,
  name: string,
  what: string,
): DescMessage => {
  const schema = found.get(name);

  if (schema === undefined) {
    throw new ContractError(
      'invalid_input',
      `No message of the bundle's files declares ${what}.`,
    );
  }

  return schema;
};

/** `scalar` as a `google.protobuf.Value`. */
const scalarValue = (scalar: IndexScalar): Value =>
  fromJson(ValueSchema, scalar);

/**
 * The documents of a `Get` or `Query` answer, each item `document` followed
 * by its chunks, decoded with `schema`.
 */
const documentsOf = <M extends Message>(
  schema: DescMessage,
  answer: readonly (GetResponse | QueryResponse)[],
): StoredDocument<M>[] => {
  const documents: {
    key: DocumentKey;
    revision: number;
    chunks: Uint8Array[];
  }[] = [];

  for (const { item } of answer) {
    if (item.case === 'document') {
      const { type, id, revision } = item.value;

      documents.push({ key: { type, id }, revision, chunks: [] });
    } else if (item.case === 'chunk') {
      documents.at(-1)?.chunks.push(item.value);
    }
  }

  return documents.map(({ key, revision, chunks }) => ({
    ...key,
    revision,
    value: decodeValue<M>(schema, chunks, key),
  }));
};

type CommitItem = MessageInitShape<typeof CommitRequestSchema>['item'];

/**
 * The items of `batch` as `Commit` sends them, every value encoded and
 * validated and every stream checked first: the expects, the deletes, each
 * put followed by its value's chunks (none for an empty value), the dropped
 * streams, the truncation, and each append followed by its events, each an
 * `event` item with the first 1 MiB of its binary and `chunk` items with the
 * rest. Throws `ContractError('invalid_input')` when a dropped, truncated or
 * appended stream has no declared message, and, with `{stream}` as
 * `details`, when an append has no events or an event encodes to no bytes,
 * which no `event` item holds.
 */
const commitItems = (
  typeSchema: (type: string) => DescMessage,
  streamSchema: (stream: string) => DescMessage,
  batch: CommitBatch,
): MessageInitShape<typeof CommitRequestSchema>[] =>
  [
    ...(batch.expect ?? []).map(
      ({ type, id, revision }): CommitItem => ({
        case: 'expect',
        value: { type, id, revision },
      }),
    ),
    ...(batch.delete ?? []).map(
      ({ type, id }): CommitItem => ({ case: 'delete', value: { type, id } }),
    ),
    ...(batch.put ?? []).flatMap(({ type, id, value }): CommitItem[] => [
      { case: 'put', value: { type, id } },
      ...chunksOf(encodeValue(typeSchema(type), value, { type, id })).map(
        (chunk): CommitItem => ({ case: 'chunk', value: chunk }),
      ),
    ]),
    ...(batch.dropStreams ?? []).map((stream): CommitItem => {
      streamSchema(stream);

      return { case: 'dropStream', value: stream };
    }),
    ...(batch.truncate === undefined
      ? []
      : [batch.truncate].map((truncate): CommitItem => {
          streamSchema(truncate.stream);

          return { case: 'truncate', value: truncate };
        })),
    ...(batch.append ?? []).flatMap(
      ({ stream, expectedSequence, events }): CommitItem[] => {
        if (events.length === 0) {
          throw new ContractError(
            'invalid_input',
            'An append needs at least one event.',
            { stream },
          );
        }

        return [
          { case: 'append', value: { stream, expectedSequence } },
          ...events.flatMap((event) =>
            eventItems(encodeValue(streamSchema(stream), event, { stream }), {
              stream,
            }),
          ),
        ];
      },
    ),
  ].map((item) => ({ item }));

/**
 * The items of one event's `bytes`: an `event` item with the first chunk and
 * a `chunk` item for each other. Throws `ContractError('invalid_input')`
 * with `key` as `details` when `bytes` is empty.
 */
const eventItems = (bytes: Uint8Array, key: ValueKey): CommitItem[] => {
  const [first, ...rest] = chunksOf(bytes);

  if (first === undefined) {
    throw new ContractError(
      'invalid_input',
      'The event encodes to no bytes; an appended event needs at least one.',
      key,
    );
  }

  return [
    { case: 'event', value: first },
    ...rest.map((chunk): CommitItem => ({ case: 'chunk', value: chunk })),
  ];
};

/** The `PutBlob` requests of `bytes`, each chunk at most `chunkBytes`. */
async function* blobChunks(
  bytes: Uint8Array | AsyncIterable<Uint8Array>,
): AsyncIterable<{ chunk: Uint8Array }> {
  for await (const part of bytes instanceof Uint8Array ? [bytes] : bytes) {
    for (const chunk of chunksOf(part)) {
      yield { chunk };
    }
  }
}
