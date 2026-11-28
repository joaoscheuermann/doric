/**
 * `storage.kv/v1` as TypeScript sees it: `Kv`, one method per RPC of
 * `KvService` over the generated messages of `doric.storage.kv.v1`; the
 * frozen limits every engine enforces; and `kvClient`, which adapts a
 * Connect client of `KvService` to a `Kv`.
 */
import { type Client, ConnectError } from '@connectrpc/connect';
import type { CallArg } from 'bundle/contracts';
import type {
  CommitRequest,
  CommitResponse,
  GetRequest,
  GetResponse,
  KvService,
  RangeRequest,
  RangeResponse,
} from 'bundle/contracts/gen/doric/storage/kv/v1/kv_pb.js';

import { clientFailure, connectOptionsOf } from './rpc/call.js';

/**
 * An ordered byte-keyed store with versions, positions and conditional
 * commits, reached as one caller. The engine serves only the platform, the
 * caller `doric` (A79), which reaches every key; any other caller is refused
 * with `not_owner` and the message `storage.kv/v1 serves only the
 * platform.`, before any other check.
 *
 * Every refusal is a `ContractError` (`bundle/contracts`) carrying the
 * contract's code and details, never a `ConnectError`: `invalid_input`,
 * `limit_exceeded` with `details.limit` one of the names of `kvLimits`,
 * `not_owner` for any caller but `doric`, without details, and
 * `condition_failed`, with `details.key` in hexadecimal,
 * `cancelled` and `deadline_exceeded` for the call's signal and deadline,
 * `unavailable` when the engine cannot be reached. The engine checks a
 * call in a fixed order and answers the first refusal:
 *
 * - `get`: no keys (`invalid_input`); more than `getKeys` keys; then, key
 *   by key, the caller's prefix and `keyBytes`.
 * - `range`: a `limit` of 0 (`invalid_input`); a `limit` above
 *   `rangeLimit`; a `start` after `end` (`invalid_input`); the prefix of
 *   `start`, then of `end`; then `keyBytes`.
 * - `commit`, item by item as they arrive: no case set (`invalid_input`);
 *   the prefix; `keyBytes` (a positioned put counts its `key_prefix` plus
 *   8 bytes); `valueBytes`; a clear range whose `start` is after its
 *   `end` (`invalid_input`); `commitItems`; `commitBytes` (every key an
 *   item names plus every value). Once the items end, a commit with no
 *   mutation is `invalid_input`; conditions are checked inside the
 *   transaction, and the first that fails, in item order, rejects the
 *   whole commit with `condition_failed`.
 *
 * A refused call reads or writes nothing. Each `get` and `range` call reads
 * one committed state. A commit applies its mutations in item order, all or
 * none.
 */
export interface Kv {
  /**
   * Reads the given keys. The answer yields one `GetResponse` per key, in
   * request order, an absent key included with no `value` and version 0.
   * Iterating rejects with the refusal when the call is refused.
   */
  get(request: GetRequest, call?: CallArg): AsyncIterable<GetResponse>;
  /**
   * Reads at most `limit` entries of `[start, end)` in unsigned bytewise
   * key order, or in reverse order with `reverse`, with their values unless
   * `keysOnly` is set. Iterating rejects with the refusal when the call is
   * refused.
   */
  range(request: RangeRequest, call?: CallArg): AsyncIterable<RangeResponse>;
  /**
   * Sends `items`, conditions and mutations, as one commit, and resolves
   * with its `position` once it is durable: above every earlier commit's,
   * and the version of every key it wrote. Rejects with the first refusal;
   * a rejected commit changes nothing. An `items` that throws ends the
   * call, which then changes nothing.
   */
  commit(
    items: Iterable<CommitRequest> | AsyncIterable<CommitRequest>,
    call?: CallArg,
  ): Promise<CommitResponse>;
}

/**
 * The limits of guarantee 6, by the names `limit_exceeded` reports in
 * `details.limit`: the bytes of one key and of one value, the keys of one
 * `get`, the `limit` of one `range`, and the items and bytes of one commit.
 * Frozen: the values never change at run time.
 */
export const kvLimits: Readonly<{
  keyBytes: 4096;
  valueBytes: 1_048_576;
  getKeys: 1000;
  rangeLimit: 1000;
  commitItems: 200_000;
  commitBytes: 67_108_864;
}> = Object.freeze({
  keyBytes: 4096,
  valueBytes: 1_048_576,
  getKeys: 1000,
  rangeLimit: 1000,
  commitItems: 200_000,
  commitBytes: 67_108_864,
});

/**
 * Adapts the generated Connect client of `KvService` to a `Kv`. Every
 * `ConnectError` the client raises, on the call, while its answer is
 * iterated or when a commit is rejected, reaches the caller as a
 * `ContractError`: one carrying a Doric `ErrorInfo` keeps its code and
 * details; otherwise gRPC CANCELLED, a client-side abort included, becomes
 * `cancelled`, DEADLINE_EXCEEDED, a client timeout included,
 * `deadline_exceeded`, UNAVAILABLE `unavailable`, and any other code
 * `internal`; an `internal` or `cancelled` failure once the call's signal
 * aborted is `cancelled`, and once its deadline passed `deadline_exceeded`,
 * whatever code the engine ended the call with. A `Call` or `CallOptions` passed as
 * `call` becomes the Connect options `{ signal, timeoutMs }` of its signal
 * and deadline; a signal that already aborted rejects with `cancelled`
 * before any call is made. The client keeps its transport, and with it the
 * caller every call is stamped with.
 */
export const kvClient = (client: Client<typeof KvService>): Kv => ({
  get: (request, call) =>
    answerOf(() => client.get(request, connectOptionsOf(call)), call),
  range: (request, call) =>
    answerOf(() => client.range(request, connectOptionsOf(call)), call),
  commit: async (items, call) => {
    try {
      return await client.commit(asyncOf(items), connectOptionsOf(call));
    } catch (error) {
      throw contractFailure(error, call);
    }
  },
});

/**
 * `error` as the caller of `call` sees it: a `ConnectError` as its
 * `ContractError`.
 */
const contractFailure = (error: unknown, call?: CallArg): unknown =>
  error instanceof ConnectError ? clientFailure(error, call) : error;

/** The answer of the server-streaming call `open` makes once iterated. */
async function* answerOf<T>(
  open: () => AsyncIterable<T>,
  call?: CallArg,
): AsyncIterable<T> {
  try {
    yield* open();
  } catch (error) {
    throw contractFailure(error, call);
  }
}

/** `items` as the async iterable a client-streaming call sends. */
async function* asyncOf<T>(
  items: Iterable<T> | AsyncIterable<T>,
): AsyncIterable<T> {
  yield* items;
}
