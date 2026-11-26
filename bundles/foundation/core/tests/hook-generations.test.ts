// The generation partition of the `hooks/v1` provider the desktop and client
// parts serve (`src/shared/hooks.ts`, D4-11): a bundle hooks contract is
// defined per `(id, generation)`, a handler joins the partition of its
// registering call, and an execution runs the kernel handlers (generation 0)
// plus those of the executing generation. Exercised on the provider
// definition, as the runtime invokes it. `core`'s host `hooks/v1` over the
// router is not partitioned by generation (D4's newest instance serves; see
// `./router/hooks.test.ts`).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppHooksV1,
  type Call,
  type CatalogSnapshot,
  type Disposable,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  defineHook,
  defineHooks,
  isContractError,
  type Services,
} from 'bundle/contracts';
import { createHopCall } from 'bundle/runtime';
import { z } from 'zod';

import { createHooks } from '../src/shared/hooks.js';

type Method = (input: unknown, call: Call, services: Services) => unknown;

/** Runs one method of the hooks provider with an explicit call. */
const method = (
  hooks: ReturnType<typeof createHooks>,
  name: string,
): Method => {
  const found = (hooks.methods as Record<string, { execute: unknown }>)[name];

  assert.ok(found, `hooks/v1 has no method ${name}`);

  return found.execute as Method;
};

/**
 * A call of `bundleId` pinned to `generation` (0 = kernel), as the runtime
 * builds it for a hop without a parent call.
 */
const callOf = (bundleId: string, generation: number): Call =>
  createHopCall({
    caller: { bundleId, version: '1.0.0', generation: generation || 1 },
    generationSignal: new AbortController().signal,
    generation,
  });

interface World {
  /** The generation the catalog reports as active. */
  active: number;
  readonly services: Services;
}

/**
 * The platform contracts the provider reads: the catalog (whose `generation`
 * is the active one and whose bundles carry `provides`) and diagnostics.
 */
const world = (
  bundles: readonly { id: string; provides: readonly string[] }[],
): World => {
  const state = { active: 1 } as World;
  const services = {
    use: (ref: { readonly id: string }) => {
      if (ref.id === DoricCatalogV1.id) {
        return {
          get: (): CatalogSnapshot =>
            ({
              generation: state.active,
              composition: {},
              bundles: bundles.map((bundle) => ({
                id: bundle.id,
                manifest: { provides: bundle.provides },
              })),
              order: bundles.map((bundle) => bundle.id),
              contracts: [],
            }) as unknown as CatalogSnapshot,
        };
      }

      if (ref.id === DoricDiagnosticsV1.id) {
        return { report: () => undefined };
      }

      throw new Error(`Unexpected use of ${ref.id}.`);
    },
  } as unknown as Services;

  (state as { services: Services }).services = services;

  return state;
};

const errorCode = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return isContractError(error) ? error.code : String(error);
  }

  return undefined;
};

const OwnerHooksV1 = defineHooks('owner.hooks/v1', {
  onNoticeHook: defineHook({
    kind: 'observe',
    input: z.object({ text: z.string() }).strict(),
  }),
});

void test('hooks run the kernel handlers plus the handlers of the executing generation only', async () => {
  const hooks = createHooks({ deadlineMs: 0 });
  const w = world([
    { id: 'kernel', provides: [] },
    { id: 'owner', provides: ['owner.hooks/v1@1.0.0'] },
    { id: 'listener', provides: [] },
  ]);
  const define = method(hooks, 'define');
  const register = method(hooks, 'register');
  const execute = method(hooks, 'execute');
  const heard: string[] = [];
  const handler = (label: string) => (input: { text: string }) => {
    heard.push(`${label}:${input.text}`);
  };

  const definedOne = define(
    OwnerHooksV1,
    callOf('owner', 1),
    w.services,
  ) as Disposable;
  define(OwnerHooksV1, callOf('owner', 2), w.services);
  register(
    [OwnerHooksV1, 'onNoticeHook', handler('kernel')],
    callOf('kernel', 0),
    w.services,
  );
  register(
    [OwnerHooksV1, 'onNoticeHook', handler('one')],
    callOf('listener', 1),
    w.services,
  );
  register(
    [OwnerHooksV1, 'onNoticeHook', handler('two')],
    callOf('listener', 2),
    w.services,
  );

  await execute(
    [OwnerHooksV1, 'onNoticeHook', { text: 'a' }],
    callOf('owner', 1),
    w.services,
  );
  await execute(
    [OwnerHooksV1, 'onNoticeHook', { text: 'b' }],
    callOf('owner', 2),
    w.services,
  );
  // A kernel execution sees the active generation.
  w.active = 2;
  await execute(
    [OwnerHooksV1, 'onNoticeHook', { text: 'c' }],
    callOf('doric', 0),
    w.services,
  );

  assert.deepEqual(heard, [
    'kernel:a',
    'one:a',
    'kernel:b',
    'two:b',
    'kernel:c',
    'two:c',
  ]);

  // Disposing generation 1's definition leaves generation 2's defined.
  const ran: string[] = [];

  method(hooks, 'whenDefined')(
    [
      OwnerHooksV1,
      () => {
        ran.push('defined');

        return () => {
          ran.push('undefined');
        };
      },
    ],
    callOf('listener', 2),
    w.services,
  );
  definedOne.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ran, ['defined']);
  assert.equal(
    errorCode(() => define(OwnerHooksV1, callOf('other', 2), w.services)),
    'not_owner',
  );
});

void test('a platform hooks contract is one shared definition seen through each view', async () => {
  const hooks = createHooks({ deadlineMs: 0 });
  const w = world([{ id: 'files', provides: [] }]);
  const heard: string[] = [];

  method(hooks, 'define')(AppHooksV1, callOf('doric', 0), w.services);
  assert.equal(
    errorCode(() =>
      method(hooks, 'define')(AppHooksV1, callOf('files', 2), w.services),
    ),
    'not_owner',
  );

  for (const generation of [1, 2]) {
    method(hooks, 'register')(
      [
        AppHooksV1,
        'onHostReadyHook',
        () => {
          heard.push(`files@${generation}`);
        },
      ],
      callOf('files', generation),
      w.services,
    );
  }

  await method(hooks, 'execute')(
    [AppHooksV1, 'onHostReadyHook', {}],
    callOf('doric', 2),
    w.services,
  );

  assert.deepEqual(heard, ['files@2']);
});
