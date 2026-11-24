// Parity of the process with today's routes (phase 3, S60d, contract s60 §6
// P1/P2): the same domain fakes answer the kernel world (`./host.ts`, the
// Express route) and the router world (`./router-fakes.ts`, the RPC); a
// refusal must carry the route's `code` as its reason, the route's `message`,
// and the gRPC code §5 gives the route's HTTP status; a success must answer
// the route's body under the RPC's wrapper.

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import { Code } from '@connectrpc/connect';

import { type Fakes, serve } from './host.js';
import type { Harness } from './router.js';
import { routerFakes } from './router-fakes.js';
import { activated, assertMessage, refusalOf } from './router-fixtures.js';

/** A kernel route: path, method and JSON body. */
export type Route = readonly [string, string?, unknown?];

/** What the kernel route answered. */
export interface RouteAnswer {
  readonly status: number;
  /** The parsed body; `undefined` for an empty one (204). */
  readonly body: unknown;
}

/** Boots the kernel over `fakes`, calls `route` once and closes it. */
export const routeAnswer = async (
  fakes: Fakes,
  [path, method, body]: Route,
): Promise<RouteAnswer> => {
  const kernel = await serve(fakes);

  try {
    const response = await kernel.request(path, method, body);
    const text = await response.text();

    return {
      status: response.status,
      body: text === '' ? undefined : JSON.parse(text),
    };
  } finally {
    await kernel.close();
  }
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
 * P1 for one case: the route refuses (status ≥ 400) and the RPC ends with the route's code as reason, its message,
 * and `code` (default: §5's code for the route's status).
 */
export const assertRefusalParity = async (
  t: TestContext,
  fakes: Fakes,
  route: Route,
  call: (h: Harness) => Promise<unknown>,
  label: string,
  code?: Code,
): Promise<void> => {
  const answer = await routeAnswer(fakes, route);
  const error = (
    answer.body as {
      readonly error?: { readonly code: string; readonly message: string };
    }
  )?.error;

  assert.ok(
    answer.status >= 400 && error !== undefined,
    `${label}: the route refuses (${answer.status} ${JSON.stringify(answer.body)})`,
  );

  const h = await routed(t, fakes);

  assert.deepEqual(
    await refusalOf(call(h)),
    {
      reason: error.code,
      message: error.message,
      code: code ?? grpcCodeOfStatus(answer.status),
    },
    label,
  );
};

/** P2 for one case: the route succeeds and the RPC answers its body under `wrap`. */
export const assertSuccessParity = async <D extends DescMessage>(
  t: TestContext,
  fakes: Fakes,
  route: Route,
  schema: D,
  call: (h: Harness) => Promise<MessageShape<D>>,
  wrap: (body: unknown) => unknown,
  label: string,
): Promise<void> => {
  const answer = await routeAnswer(fakes, route);

  assert.ok(
    answer.status < 300,
    `${label}: the route succeeds (${answer.status} ${JSON.stringify(answer.body)})`,
  );

  const h = await routed(t, fakes);

  assertMessage(schema, await call(h), wrap(answer.body), label);
};
