// `executor.session/v1` over the router (phase 3, slice S48b): the callbacks
// of one `executor/v1` call, reached by its session id.

import type { JsonObject } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { decodeJson } from 'storage/rpc';

import type { PromptSession } from '../../contracts/executor.js';
import {
  type RecordRequest,
  type SessionService,
  SteerInputSchema,
} from '../../contracts/gen/doric/executor/session/v1/session_pb.js';
import { ThreadPersistenceError } from '../domain/runtime.js';
import type { ExecutorSessions } from '../executor-sessions.js';
import { callerInstanceOf } from '../sessions.js';
import { encode, runtimeOneofs } from './codec.js';
import { detached, routed } from './errors.js';
import { readHistoryItems } from './history.js';
import { routedItems } from './streams.js';

/**
 * `executor.session/v1` over `sessions`. Every method first resolves
 * `sessions.get(sessionId, callerInstanceOf(context))` — the caller is the
 * stamped one — so an unknown/ended id, another bundle, or (after the first
 * callback) another instance fails `NOT_FOUND` `unknown_session`. Domain
 * failures pass through `routedError`. Not gated on `activate`: before it no
 * session exists, so every call is `unknown_session`.
 *
 * - `ReadHistory{sessionId, part}`: `readHistoryItems(history.format, await
 *   history.read(part))`. The format is read after `read` resolved (a
 *   `record` in between is seen).
 * - `Record` (client streaming): the first item must be `head{sessionId,
 *   format?}`; then per part `part` + ≥ 1 `chunk`; then at most one `event`,
 *   last. Parsed fully before anything is applied; then `record({history?:
 *   {format, parts}, event?})` once, `detached` (D7) — `history` when ≥ 1
 *   part arrived (then `format` is required), `event` as the Struct's JSON
 *   object. Answers `{}`.
 *   - `invalid_input` (INVALID_ARGUMENT): first item not `head`, a second
 *     `head`, `chunk` before `part`, a part without chunk or repeated, parts
 *     without `format`, an item after `event`, a part that is not UTF-8 JSON.
 *     Nothing is recorded then.
 *   - `unsupported_operation` (UNIMPLEMENTED): the session has no `record`
 *     (checkpoint/rewind).
 *   - a `ThreadPersistenceError` from `record` fails `unavailable`
 *     (UNAVAILABLE), message 'Thread persistence failed.' (D5); the domain
 *     keeps its retry (`session.failure`).
 * - `TakeSteers{sessionId}`: `{steers}` from `steers?.() ?? []`, each
 *   `{prompt, source}` encoded with `runtimeOneofs` (the `InputSource`
 *   discriminator). Each input is answered once.
 * - `DescribeAttachment{sessionId, id}`: `{attachment: {id, name, mediaType,
 *   size}}` of `attachment?.(id)` without `bytes`; `{}` when it answers
 *   `undefined` or the session has no `attachment` (D8: the blob is read).
 */
export const routedSessionService = (
  sessions: ExecutorSessions,
): ServiceImpl<typeof SessionService> => {
  const sessionOf = (sessionId: string, context: HandlerContext) =>
    sessions.get(sessionId, callerInstanceOf(context));

  return {
    readHistory: ({ sessionId, part }, context) =>
      routedItems(async function* () {
        const { history } = sessionOf(sessionId, context);
        const value = await history.read(part);
        yield* readHistoryItems(history.format, value);
      }),
    record: (requests, context) =>
      routed(async () => {
        const record = await recordOf(requests, (sessionId) => {
          const session = sessionOf(sessionId, context);
          if (session.record === undefined)
            throw new ContractError(
              'unsupported_operation',
              'This executor session records nothing.',
            );
          return session.record.bind(session);
        });
        try {
          await detached(record);
        } catch (error) {
          if (error instanceof ThreadPersistenceError)
            throw new ContractError('unavailable', error.message);
          throw error;
        }
        return {};
      }),
    takeSteers: ({ sessionId }, context) =>
      routed(async () => {
        const session = sessionOf(sessionId, context);
        const steers = (await session.steers?.()) ?? [];
        return {
          steers: steers.map((steer) =>
            encode(SteerInputSchema, steer, runtimeOneofs),
          ),
        };
      }),
    describeAttachment: ({ sessionId, id }, context) =>
      routed(async () => {
        const session = sessionOf(sessionId, context);
        const attachment = await session.attachment?.(id);
        if (attachment === undefined) return {};
        const { name, mediaType, size } = attachment;
        return { attachment: { id: attachment.id, name, mediaType, size } };
      }),
  };
};

/**
 * A `Record` stream parsed in full: the one `record` call it asks for of the
 * session its head names (`resolve`). `invalid_input` when malformed.
 */
const recordOf = async (
  requests: AsyncIterable<RecordRequest>,
  resolve: (sessionId: string) => PromptSession['record'],
): Promise<() => Promise<void>> => {
  const invalid = (message: string) =>
    new ContractError('invalid_input', message);
  let record: PromptSession['record'] | undefined;
  let format: string | undefined;
  const parts = new Map<string, Uint8Array[]>();
  let current: Uint8Array[] | undefined;
  let event: JsonObject | undefined;
  for await (const { item } of requests) {
    if (record === undefined) {
      if (item.case !== 'head')
        throw invalid('A Record stream starts with its head.');
      record = resolve(item.value.sessionId);
      format = item.value.format;
      continue;
    }
    if (event !== undefined)
      throw invalid('Nothing follows the event of a Record stream.');
    if (item.case === 'head') throw invalid('A Record stream has one head.');
    if (item.case === 'part') {
      if (current?.length === 0)
        throw invalid('A history part arrived without any chunk.');
      if (parts.has(item.value))
        throw invalid(`History part ${item.value} arrived twice.`);
      current = [];
      parts.set(item.value, current);
    } else if (item.case === 'chunk') {
      if (current === undefined)
        throw invalid('A history chunk arrived before any part.');
      current.push(item.value);
    } else if (item.case === 'event') {
      event = item.value;
    }
  }
  if (record === undefined)
    throw invalid('A Record stream starts with its head.');
  if (current?.length === 0)
    throw invalid('A history part arrived without any chunk.');
  if (parts.size > 0 && format === undefined)
    throw invalid('History parts need a format.');
  const history =
    parts.size === 0 || format === undefined
      ? undefined
      : {
          format,
          parts: Object.fromEntries(
            [...parts].map(([part, chunks]) => [
              part,
              decodeJson(chunks, 'invalid_input'),
            ]),
          ),
        };
  const recordTo = record;
  return () =>
    recordTo({
      ...(history === undefined ? {} : { history }),
      ...(event === undefined ? {} : { event }),
    });
};
