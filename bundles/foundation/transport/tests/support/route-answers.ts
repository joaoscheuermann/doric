// Today's route answers as the RPCs keep them (phase 3, S60d, contract s60 §6
// P1/P2), stated per case since the kernel routes left (S69): a refusal must
// carry the route's `code` as its reason, the route's `message`, and the gRPC
// code §5 gives the route's HTTP status; a success must answer the route's
// body under the RPC's wrapper. The stated refusals are the REST error table
// of `runtime/contracts` (`restErrors`, as `rest-errors.test.ts` compared the
// routes with it) or the route's own sentence.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';
import type { RestError } from 'runtime/contracts';

import type { Harness } from './router.js';
import { type Fakes, routerFakes } from './router-fakes.js';
import { activated, assertMessage, refusalOf } from './router-fixtures.js';

/** The refusal of an unexpected failure: no cause, today's 500 sentence. */
export const internalError: RestError = {
  status: 500,
  code: 'internal_error',
  message: 'The request could not be completed.',
};

/** §5: the gRPC code of a route refusal by its HTTP status (Q2's two exceptions are the caller's). */
export const grpcCodeOfStatus = (status: number): Code => {
  if (status === 400 || status === 422) return Code.InvalidArgument;
  if (status === 404) return Code.NotFound;
  if (status === 409 || status === 410) return Code.FailedPrecondition;
  if (status === 502 || status === 503) return Code.Unavailable;
  if (status === 500) return Code.Internal;

  return assert.fail(`no §5 row for HTTP ${status}`);
};

/** The harness over the domain fakes `fakes`, activated for one test. */
export const routed = (t: TestContext, fakes: Fakes): Promise<Harness> =>
  activated(t, { fakes: (record) => routerFakes(record, fakes) });

/**
 * P1 for one case: the RPC ends with the route refusal `expected` — its code as
 * reason, its message, and `code` (default: §5's code for its status).
 */
export const assertRouteRefusal = async (
  t: TestContext,
  fakes: Fakes,
  expected: RestError | undefined,
  call: (h: Harness) => Promise<unknown>,
  label: string,
  code?: Code,
): Promise<void> => {
  assert.ok(expected !== undefined, `${label}: the route refuses`);

  const h = await routed(t, fakes);

  assert.deepEqual(
    await refusalOf(call(h)),
    {
      reason: expected.code,
      message: expected.message,
      code: code ?? grpcCodeOfStatus(expected.status),
    },
    label,
  );
};

/** P2 for one case: the RPC answers the route's body `body` under `wrap`. */
export const assertRouteSuccess = async <D extends DescMessage>(
  t: TestContext,
  fakes: Fakes,
  body: unknown,
  schema: D,
  call: (h: Harness) => Promise<MessageShape<D>>,
  wrap: (body: unknown) => unknown,
  label: string,
): Promise<void> => {
  const h = await routed(t, fakes);

  assertMessage(schema, await call(h), wrap(body), label);
};
