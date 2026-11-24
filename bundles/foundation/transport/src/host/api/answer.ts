import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { ContractError, isContractError } from 'bundle/contracts';
import type { Response } from 'express';
import { decode, type RestError } from 'runtime/contracts';

import { sendError } from '../errors.js';

/** What a route reads from its request, as Express gives it. */
export interface RouteInput {
  /** The path parameters by Express name (`id`, `promptId`); any string. */
  readonly params: Readonly<Record<string, string>>;
  /** The query object (`request.query`), `{}` when none; values may be strings or, from the process, numbers. */
  readonly query: unknown;
  /** The JSON body (`request.body`), `undefined` when none. */
  readonly body: unknown;
}

/**
 * What one route answers: a value with today's success status (`204` carries `undefined`), today's `202 {status:
 * 'pending'}` with `Retry-After: 1`, or a refusal with today's status, code and message.
 */
export type ApiAnswer<T> =
  | {
      readonly kind: 'ok';
      readonly status: 200 | 201 | 202 | 204;
      readonly value: T;
    }
  | { readonly kind: 'pending' }
  | { readonly kind: 'refused'; readonly error: RestError };

/** Writes `answer` as today's HTTP answer (the route sets `Cache-Control` itself, as today). Never throws. */
export const sendAnswer = (
  response: Response,
  answer: ApiAnswer<unknown>,
): void => {
  switch (answer.kind) {
    case 'pending':
      response.set('Retry-After', '1').status(202).json({ status: 'pending' });
      return;
    case 'refused':
      sendError(
        response,
        answer.error.status,
        answer.error.code,
        answer.error.message,
      );
      return;
    case 'ok':
      if (answer.status === 204) {
        response.status(204).end();
        return;
      }
      response.status(answer.status).json(answer.value);
  }
};

/** The `ContractError` a refusal ends an RPC with: `new ContractError(error.code, error.message)`, no details. */
export const apiError = (error: RestError): ContractError =>
  new ContractError(error.code, error.message);

/** The failure codes an RPC passes through unchanged: a gRPC client retries on them. */
const passedFailures = new Set([
  'unavailable',
  'generation_lost',
  'limit_exceeded',
  'deadline_exceeded',
  'cancelled',
]);

/**
 * The `ContractError` an unexpected failure ends an RPC with (D3): a `ContractError` (or `ConnectError`, as
 * `contractErrorOf` reads it) whose code is `unavailable`, `generation_lost`, `limit_exceeded`, `deadline_exceeded` or
 * `cancelled` unchanged; anything else `ContractError('internal_error', 'The request could not be completed.')`, its
 * cause dropped. Pure; never throws.
 */
export const apiFailure = (error: unknown): ContractError =>
  isContractError(error) && passedFailures.has(error.code)
    ? error
    : new ContractError(
        'internal_error',
        'The request could not be completed.',
      );

/**
 * `answer`'s value for an RPC whose route never answers `pending`; throws `apiError` for a refusal. A `pending` answer
 * here is a programming error and throws `apiFailure`'s `internal_error`.
 */
export const answerValue = <T>(answer: ApiAnswer<T>): T => {
  if (answer.kind === 'ok') return answer.value;
  if (answer.kind === 'refused') throw apiError(answer.error);
  throw apiFailure(new Error('A pending answer has no value.'));
};

/**
 * The request as the route would read it: the fields named in `params` (request JSON name → Express name, e.g.
 * `{projectId: 'id', promptId: 'promptId'}`) become `params`; every other field of `decode(schema, request)` becomes
 * both `query` and `body` (the operation reads the one its route reads). Pure; never throws.
 */
export const routeInputOf = <D extends DescMessage>(
  schema: D,
  request: MessageShape<D>,
  params: Readonly<Record<string, string>>,
): RouteInput => {
  const fields = Object.entries(
    decode(schema, request) as Readonly<Record<string, unknown>>,
  );
  const rest = Object.fromEntries(
    fields.filter(([field]) => !Object.hasOwn(params, field)),
  );
  return {
    params: Object.fromEntries(
      fields.flatMap(([field, value]) => {
        const name = params[field];
        return name === undefined ? [] : [[name, String(value)]];
      }),
    ),
    query: rest,
    body: rest,
  };
};
