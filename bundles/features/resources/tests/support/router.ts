// The harness of `resources`' host part through the router (phase 3, slice
// S50b): `resources/v1` served by `createTestRouter` as `src/host/main.ts`
// serves it (`createResourcesService`, `activate`), with a recording fake of
// `runtime.lease/v1`'s `Stats`.

import type { TestContext } from 'node:test';

import type {
  DescService,
  JsonValue,
  MessageInitShape,
} from '@bufbuild/protobuf';
import { toJson } from '@bufbuild/protobuf';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { type CallScope, callOf } from 'bundle/contracts';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import {
  LeaseService,
  StatsRequestSchema,
  type StatsResponseSchema,
} from 'runtime/contracts/gen/doric/runtime/lease/v1/lease_pb.js';

import { ResourcesService } from '../../src/contracts/gen/doric/resources/v1/resources_pb.js';
import { createResourcesService } from '../../src/host/rpc/resources.js';

/** The services `resources`' host part declares it calls. */
export const REQUIRES = [LeaseService.typeName];

/** One `Stats` the lease fake received. */
export interface StatsRecord {
  /** The request, as JSON. */
  readonly request: JsonValue;
  readonly scope: CallScope | undefined;
}

export interface HarnessOptions {
  /**
   * What `Stats` answers, or throws (a `ContractError` fails the call with
   * its code); `{}` (no reading) by default.
   */
  readonly stats?: () => MessageInitShape<typeof StatsResponseSchema>;
}

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

/**
 * `resources`' host part activated on a test router as `main.ts` runs it
 * (`services: [[ResourcesService, implementation]]`, `activate`), `requires`
 * `runtime.lease/v1`, beside a recording fake of its `Stats`.
 */
export const harness = async (
  t: TestContext,
  options: HarnessOptions = {},
): Promise<{
  readonly router: TestRouter;
  /** The `Stats` calls the fake received, in order. */
  readonly stats: StatsRecord[];
  /** A client of the part, with no scope or with `scope`. */
  client(scope?: CallScope): Client<typeof ResourcesService>;
}> => {
  const stats: StatsRecord[] = [];
  const router = createTestRouter({
    requires: REQUIRES,
    instance: { bundleId: 'resources' },
    fakes: [
      fakeOf(LeaseService, {
        stats: (request, context) => {
          stats.push({
            request: toJson(StatsRequestSchema, request),
            scope: callOf(context).scope,
          });

          return options.stats?.() ?? {};
        },
      }),
    ],
  });
  const handle = createResourcesService();

  t.after(() => router.control.stop());

  await router.activate({
    services: [[ResourcesService, handle.implementation]],
    activate: (context) => handle.activate(context),
  });

  return {
    router,
    stats,
    client: (scope) =>
      router.client(ResourcesService, scope === undefined ? {} : { scope }),
  };
};
