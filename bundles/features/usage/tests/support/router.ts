// The harness of `usage`'s host part through the router (phase 3, slice
// S50c): `usage/v1` served by `createTestRouter` as `src/host/main.ts` serves
// it (`createUsageService`, `activate` binding its clients), with recording
// fakes of `runtime.usage/v1` (`Read`), `runtime.threads/v1` (`Compact`),
// `host-config/v1` (`Current`, `Replace`) and `models/v1` (`ContextWindow`).
// Each fake records its request (as JSON) and `callOf(context).scope`.

import type {
  DescService,
  JsonValue,
  MessageInitShape,
} from '@bufbuild/protobuf';
import { toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { type CallScope, callOf } from 'bundle/contracts';
import {
  ContextWindowRequestSchema,
  ModelsService,
} from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import type { ServiceEntry } from 'bundle/host';
import { createTestRouter, type TestRouter } from 'bundle/testing';
import type { ConfigurationValueSchema } from 'host-config/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import {
  HostConfigService,
  type ReplaceResponseSchema,
} from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import {
  type CompactResponseSchema,
  ThreadsService,
} from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { UsageService as RuntimeUsageService } from 'runtime/contracts/gen/doric/runtime/usage/v1/usage_pb.js';
import type { ThreadUsageSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { UsageService } from '../../src/contracts/gen/doric/usage/v1/usage_pb.js';
import { createUsageService } from '../../src/host/rpc/usage.js';

/** The scope of every call the test makes to `usage/v1`. */
export const scope: CallScope = {
  projectId: 'project-1',
  threadId: 'thread-1',
};

/** The services `usage`'s host part declares it calls. */
export const REQUIRES = [
  RuntimeUsageService.typeName,
  ThreadsService.typeName,
  HostConfigService.typeName,
  ModelsService.typeName,
];

/** One request a fake received, with the scope it carried. */
export interface Recorded<T> {
  readonly request: T;
  readonly scope: CallScope | undefined;
}

/** A stored usage, as `runtime.usage/v1.Read` answers it. */
export type ThreadUsageInit = MessageInitShape<typeof ThreadUsageSchema>;
/** A configuration, as `host-config/v1.Current` answers it. */
export type ConfigurationInit = MessageInitShape<
  typeof ConfigurationValueSchema
>;
/** A compaction outcome, as `runtime.threads/v1.Compact` answers it. */
export type CompactInit = MessageInitShape<typeof CompactResponseSchema>;

export interface HarnessOptions {
  /** `Read{threadId}`: the stored usage, or `undefined`; a throw fails it. */
  readonly read?: (threadId: string) => ThreadUsageInit | undefined;
  /** `ContextWindow`: the capacity, or `undefined`; a throw fails it. */
  readonly contextWindow?: () => number | undefined;
  /** `Compact{id}`: the outcome; a throw fails it. */
  readonly compact?: (id: string) => CompactInit;
  /** `Current{}`: the configuration in force; a throw fails it. */
  readonly current?: () => ConfigurationInit;
  /** `Replace{input}`: how it ended; a throw fails it. Default `replaced`. */
  readonly replace?: (input: JsonValue) => 'replaced' | 'invalid' | 'rejected';
}

export interface Harness {
  readonly router: TestRouter;
  /** A client of the bundle's `usage/v1`, scoped to {@link scope}. */
  readonly client: Client<typeof UsageService>;
  /** `runtime.usage/v1.Read` thread ids. */
  readonly reads: Recorded<string>[];
  /** `models/v1.ContextWindow` requests, as JSON. */
  readonly contextWindows: Recorded<JsonValue>[];
  /** `runtime.threads/v1.Compact` ids. */
  readonly compacts: Recorded<string>[];
  /** `host-config/v1.Current` calls. */
  readonly currents: Recorded<null>[];
  /** `host-config/v1.Replace` inputs. */
  readonly replaces: Recorded<JsonValue>[];
  /** Activates the part as `main.ts` does. */
  activate(): Promise<void>;
  /** Serves `usage/v1` without running the handle's `activate`. */
  serveWithoutActivate(): Promise<void>;
}

/** A `[Service, implementation]` fake that serves only the methods given. */
const fakeOf = <S extends DescService>(
  service: S,
  implementation: Partial<ServiceImpl<S>>,
): ServiceEntry => [service, implementation as ServiceImpl<S>] as ServiceEntry;

const updatedAt = '2026-11-23T12:00:00.000Z';

/** `usage`'s host part on a test router, not yet activated. */
export const harness = (options: HarnessOptions = {}): Harness => {
  const usage = createUsageService();
  const reads: Recorded<string>[] = [];
  const contextWindows: Recorded<JsonValue>[] = [];
  const compacts: Recorded<string>[] = [];
  const currents: Recorded<null>[] = [];
  const replaces: Recorded<JsonValue>[] = [];
  const current = (): ConfigurationInit => {
    if (options.current === undefined) {
      throw new Error('Current is not expected.');
    }

    return options.current();
  };

  const router = createTestRouter({
    scope,
    requires: REQUIRES,
    fakes: [
      fakeOf(RuntimeUsageService, {
        read: (request, context) => {
          reads.push({
            request: request.threadId,
            scope: callOf(context).scope,
          });

          const threadUsage = options.read?.(request.threadId);

          return threadUsage === undefined ? {} : { threadUsage };
        },
      }),
      fakeOf(ModelsService, {
        contextWindow: (request, context) => {
          contextWindows.push({
            request: toJson(ContextWindowRequestSchema, request),
            scope: callOf(context).scope,
          });

          const contextWindow = options.contextWindow?.();

          return contextWindow === undefined ? {} : { contextWindow };
        },
      }),
      fakeOf(ThreadsService, {
        compact: (request, context) => {
          compacts.push({ request: request.id, scope: callOf(context).scope });

          if (options.compact === undefined) {
            throw new Error('Compact is not expected.');
          }

          return options.compact(request.id);
        },
      }),
      fakeOf(HostConfigService, {
        current: (_request, context) => {
          currents.push({ request: null, scope: callOf(context).scope });

          return {
            doricConfiguration: {
              configuration: current(),
              revision: 3,
              updatedAt,
            },
          };
        },
        replace: (
          request,
          context,
        ): MessageInitShape<typeof ReplaceResponseSchema> => {
          const input =
            request.input === undefined
              ? null
              : toJson(ValueSchema, request.input);

          replaces.push({ request: input, scope: callOf(context).scope });

          const status = options.replace?.(input) ?? 'replaced';

          switch (status) {
            case 'replaced':
              return {
                status: {
                  case: 'replaced',
                  value: {
                    config: {
                      configuration: current(),
                      revision: 4,
                      updatedAt,
                    },
                  },
                },
              };
            case 'invalid':
              return {
                status: {
                  case: 'invalid',
                  value: { message: 'The Doric configuration is invalid.' },
                },
              };
            case 'rejected':
              return { status: { case: 'rejected', value: {} } };
          }
        },
      }),
    ],
  });

  return {
    router,
    client: router.client(UsageService),
    reads,
    contextWindows,
    compacts,
    currents,
    replaces,
    activate: async () => {
      await router.activate({
        services: [[UsageService, usage.implementation]],
        activate: (context) => usage.activate(context),
      });
    },
    serveWithoutActivate: async () => {
      await router.activate({
        services: [[UsageService, usage.implementation]],
        activate: () => undefined,
      });
    },
  };
};
