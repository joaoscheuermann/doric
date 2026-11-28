/**
 * The TypeScript types of the `storage/v2` client (spec
 * `docs/designs/grpc-processes.md`, "The TypeScript client"): today's
 * `storage/v1` types (`bundle/contracts`'s `basic/storage.ts`) with a
 * protobuf-es message for every document value and appended event, and a
 * query page that ends exactly when `nextCursor` is `null` (A39).
 *
 * Every refusal of a method is a `ContractError` of `bundle/contracts`,
 * never a `ConnectError`: the engine's codes and details pass through as it
 * answered them, a transport failure is `cancelled`, `deadline_exceeded` or
 * `unavailable` as `clientFailure` (`../rpc/call.ts`) maps it, and the
 * client's own refusals of a method, made before any call, are
 * `invalid_input`, and `cancelled` or `deadline_exceeded` for the call;
 * `limit_exceeded` with `{limit: 'descriptorSet'}` comes only from
 * `openStorage` and `registerOver`.
 */
import type { Message } from '@bufbuild/protobuf';
import type { CallArg } from 'bundle/contracts';

import type { IndexScalar } from '../keys.js';

/** A document's address: its storage type and its id within the type. */
export interface DocumentKey {
  /** A type the client's files declare, `<owner>.<name>/v<major>`. */
  readonly type: string;
  /** The document's id. */
  readonly id: string;
}

/**
 * A query of one index of one type: the documents whose first index values
 * equal `equals`, the next one within `range`, in key order or reversed.
 */
export interface StorageQuery {
  /** A type the client's files declare. */
  readonly type: string;
  /** An index of `type`, by its name. */
  readonly index: string;
  /** The leading values of the index, at most as many as its fields. */
  readonly equals: readonly IndexScalar[];
  /** Bounds on the index value after `equals`; at most one of each pair. */
  readonly range?: {
    readonly gt?: IndexScalar;
    readonly gte?: IndexScalar;
    readonly lt?: IndexScalar;
    readonly lte?: IndexScalar;
  };
  /** Key order, `'asc'` when absent. */
  readonly order?: 'asc' | 'desc';
  /** The most documents of the page, 1 to 1,000. */
  readonly limit: number;
  /** A previous page's `nextCursor` for the same query. */
  readonly cursor?: string;
}

/** A stored document, its value decoded with its type's message. */
export interface StoredDocument<M extends Message = Message> {
  readonly type: string;
  readonly id: string;
  /** A whole number from 1, raised by each commit that writes the document. */
  readonly revision: number;
  /** The value, unknown fields kept. */
  readonly value: M;
}

/**
 * One page of a query, read from one snapshot. `items` holds `limit`
 * documents unless the list ends with it; a shorter page never means the end
 * by itself. `nextCursor` is `null` exactly at the end of the list, and
 * otherwise continues the query strictly after the page's last document
 * (A39).
 */
export interface StoragePage<M extends Message = Message> {
  readonly items: readonly StoredDocument<M>[];
  readonly nextCursor: string | null;
}

/** A read of a stream's entries after `afterSequence`. */
export interface StreamRead {
  /** `<owner>.<family>/<key>`, a prefix the client's files declare. */
  readonly stream: string;
  /** A whole number from 0. */
  readonly afterSequence: number;
  /** The most entries, from 1. */
  readonly limit: number;
}

/** One stored stream entry, its value decoded with its prefix's message. */
export interface StreamEntry<M extends Message = Message> {
  /** A whole number from 1, the stream's counter when it was appended. */
  readonly sequence: number;
  readonly value: M;
  /** ISO-8601 with milliseconds, UTC, set by the engine at commit. */
  readonly createdAt: string;
}

/** A truncation: the entries above `afterSequence` were removed. */
export interface TruncationMark {
  readonly afterSequence: number;
  /** The stream's `lastSequence` when the truncation committed. */
  readonly atSequence: number;
}

/** One page of a stream read. */
export interface StreamPage<M extends Message = Message> {
  readonly entries: readonly StreamEntry<M>[];
  /** The stream's counter: it never decreases, even after a truncation. */
  readonly lastSequence: number;
  /**
   * The marks with `afterSequence < request.afterSequence <= atSequence`:
   * the truncations that removed entries this reader may already hold.
   */
  readonly truncations: readonly TruncationMark[];
}

/** A condition of a commit: the document's revision; 0 means absent. */
export interface ExpectedRevision extends DocumentKey {
  readonly revision: number;
}

/** A document a commit writes. */
export interface DocumentPut extends DocumentKey {
  /** A message whose `$typeName` is the message `type` is declared by. */
  readonly value: Message;
}

/** Events a commit appends to one stream. */
export interface StreamAppend {
  readonly stream: string;
  /** The stream's `lastSequence` the append expects; absent checks none. */
  readonly expectedSequence?: number;
  /**
   * At least one, each a message of the stream prefix's declared message
   * that encodes to at least one byte: no events, or an event that encodes
   * to none, is `invalid_input`, with `{stream}` as `details`, before any
   * call.
   */
  readonly events: readonly Message[];
}

/**
 * One atomic batch: it applies in this order, all or nothing, in one
 * transaction: expect, delete, put, dropStreams, truncate, append.
 */
export interface CommitBatch {
  readonly expect?: readonly ExpectedRevision[];
  readonly put?: readonly DocumentPut[];
  readonly delete?: readonly DocumentKey[];
  /**
   * Removes whole streams, entries and marks. A stream
   * whose prefix the client's files declare no message for is
   * `invalid_input` before any call.
   */
  readonly dropStreams?: readonly string[];
  /**
   * Removes a stream's entries above `afterSequence`. A
   * stream the client's files declare no message for is `invalid_input`
   * before any call.
   */
  readonly truncate?: {
    readonly stream: string;
    readonly afterSequence: number;
  };
  /** Events to append, each stream's after its last sequence. */
  readonly append?: readonly StreamAppend[];
}

/** What a commit answers once it is durable. */
export interface CommitResult {
  /** Above every earlier commit's position. */
  readonly position: number;
}

/**
 * The engine's measurements of its filesystem; the low-storage policy is the
 * caller's. A disk that cannot be measured is `unavailable` without `disk`.
 */
export interface StorageHealth {
  readonly status: 'ok' | 'unavailable';
  readonly writable: boolean;
  readonly reason?: string;
  readonly disk?: {
    readonly blocks: number;
    readonly availableBlocks: number;
  };
}

/**
 * `storage/v2` as a bundle sees it, every call made as the bundle the
 * transport stamps (the router, or `storage/testing`'s test process), under
 * that bundle's prefix only. Opened by `openStorage`, which registered the
 * bundle's files first.
 *
 * Refusals the client makes before any call, on every method that takes a
 * value or a type: `invalid_input` for a type or a stream prefix its files
 * declare no message for, and for a value whose `$typeName` is not the
 * declared message's; `invalid_input` with `details` `{ type, id }` and the
 * first violation in the message for a value that breaks a `buf.validate`
 * rule of its message; `cancelled` when `call`'s signal already aborted.
 * The engine's refusals pass through: among them `not_owner` for a type or
 * stream of another namespace, `unknown_type`, `unique_conflict` `{ type,
 * index }`, `revision_conflict`, `limit_exceeded` with `details.limit`, and
 * `invalid_input`. A value the engine answers that does not decode with its
 * message is `invalid_output` with `details` `{ type, id }`.
 *
 * Until S78 the engine does not serve `Health`, `PutBlob`, `GetBlob` or
 * `DeleteBlob`: `health`, `putBlob`, `getBlob` and `deleteBlob`
 * reject with `unknown_contract` (gRPC UNIMPLEMENTED), message `This bundle
 * does not serve /doric.storage.v2.StorageService/<Method>.`.
 */
export interface Storage {
  /**
   * The document at `key`, its value decoded with the message of
   * `key.type`, or `undefined` when it is absent. Header and chunks are read
   * from one snapshot.
   */
  get<M extends Message>(
    key: DocumentKey,
    call?: CallArg,
  ): Promise<StoredDocument<M> | undefined>;
  /**
   * One page of `query` from one snapshot, ties on a non-unique index
   * ordered by id, bytewise. A `cursor` that does not decode or falls
   * outside the query's bounds is `invalid_input`.
   */
  query<M extends Message>(
    query: StorageQuery,
    call?: CallArg,
  ): Promise<StoragePage<M>>;
  /** One page of a stream. */
  read<M extends Message>(
    request: StreamRead,
    call?: CallArg,
  ): Promise<StreamPage<M>>;
  /**
   * Encodes and validates every value and checks every type and stream,
   * then sends `batch` as one `Commit`, each value in chunks of at most
   * 1 MiB (an event as an `event` item of its first 1 MiB and `chunk` items
   * of the rest), and resolves once it is durable. A type or stream the
   * client has no message for, or an event that encodes to no bytes, is
   * `invalid_input` and no `Commit` is called. A rejected commit changes
   * nothing.
   */
  commit(batch: CommitBatch, call?: CallArg): Promise<CommitResult>;
  /** The engine's measurements. Rejects with `unknown_contract` until S78. */
  health(call?: CallArg): Promise<StorageHealth>;
  /**
   * Stores `bytes` and answers `sha256:<hex>` of them. Rejects with
   * `unknown_contract` until S78.
   */
  putBlob(
    bytes: Uint8Array | AsyncIterable<Uint8Array>,
    call?: CallArg,
  ): Promise<{ readonly hash: string }>;
  /**
   * The blob's bytes in chunks, or `undefined` when it is absent. Rejects
   * with `unknown_contract` until S78.
   */
  getBlob(
    hash: string,
    call?: CallArg,
  ): Promise<AsyncIterable<Uint8Array> | undefined>;
  /**
   * Removes the blob; an absent or malformed hash is a no-op. Rejects with
   * `unknown_contract` until S78.
   */
  deleteBlob(hash: string, call?: CallArg): Promise<void>;
}
