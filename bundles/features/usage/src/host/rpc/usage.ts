// `usage/v1` served through the router (phase 3, slice S50c): the usage
// projection of `runtime.usage/v1` with its context capacity filled from
// `models/v1`, compaction through `runtime.threads/v1`, and the compaction
// line read from and written to `host-config/v1`.

import { fromJson, type JsonObject, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { Client, ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import { contractErrorOf, type HostContext } from 'bundle/host';
import { defaultContextCompaction } from 'host-config/contracts';
import {
  type ConfigurationValue,
  ConfigurationValueSchema,
} from 'host-config/contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import { HostConfigService } from 'host-config/contracts/gen/doric/host_config/v1/host_config_pb.js';
import { ThreadsService } from 'runtime/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { UsageService as RuntimeUsageService } from 'runtime/contracts/gen/doric/runtime/usage/v1/usage_pb.js';

import type { UsageService } from '../../contracts/gen/doric/usage/v1/usage_pb.js';
import { withContextCapacity } from '../usage.js';

export interface UsageServiceHandle {
  /**
   * `usage/v1` over the router. Every call inherits the handler call's scope,
   * deadline and signal; a failure of a routed call rejects with the
   * `ContractError` `contractErrorOf` reads, unless stated otherwise.
   *
   * - `Thread{threadId}`: `runtime.usage/v1.Read{threadId}`. An absent
   *   `threadUsage` answers `{}` and asks no model. Otherwise it answers
   *   `withContextCapacity(threadUsage, r => models/v1.ContextWindow(r))`;
   *   a `ContextWindow` failure leaves the usage unchanged.
   * - `Compact{threadId}`: `runtime.threads/v1.Compact{id: threadId}`. The
   *   answer's `status`, `condensedMessages`, `retainedMessages`,
   *   `tokensFreed`, `reason` and `code` are copied as present.
   * - `CompactionTarget{}`: `host-config/v1.Current{}`. Answers
   *   `configuration.execution.contextCompaction.pressurePercent`, or
   *   `defaultContextCompaction.pressurePercent` (80) when the section is
   *   absent.
   * - `SetCompactionTarget{pressurePercent}`:
   *   - reads `Current{}`, and takes the configuration's JSON
   *     (`toJson(ConfigurationValueSchema, …, {alwaysEmitImplicit: true})`)
   *     and its section (stored, else `defaultContextCompaction`);
   *   - calls `Replace{input}` with that JSON, its
   *     `execution.contextCompaction` set to `{…section, pressurePercent}`,
   *     every other member unchanged;
   *   - answers `pressurePercent` when the answer is `replaced`, the
   *     section's previous `pressurePercent` when it is `invalid` or
   *     `rejected`.
   *   No lock: a concurrent replacement between `Current` and `Replace` is
   *   overwritten, as today.
   *
   * Before `activate`, every method fails `unavailable`.
   */
  readonly implementation: ServiceImpl<typeof UsageService>;
  /** Binds the four clients; makes no call. */
  activate(context: Pick<HostContext, 'services'>): void;
}

/** The four routed clients `activate` binds. */
interface Clients {
  readonly usage: Client<typeof RuntimeUsageService>;
  readonly threads: Client<typeof ThreadsService>;
  readonly hostConfig: Client<typeof HostConfigService>;
  readonly models: Client<typeof ModelsService>;
}

/** `work`'s answer; a routed failure rejects as `contractErrorOf` reads it. */
const routed = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw contractErrorOf(error);
  }
};

/** The configuration in force, as `host-config/v1.Current{}` answers it. */
const currentConfiguration = async (
  hostConfig: Client<typeof HostConfigService>,
): Promise<ConfigurationValue> => {
  const { doricConfiguration } = await hostConfig.current({});
  const configuration = doricConfiguration?.configuration;
  if (configuration === undefined) {
    throw new ContractError(
      'invalid_output',
      'host-config/v1.Current answered no configuration.',
    );
  }
  return configuration;
};

export const createUsageService = (): UsageServiceHandle => {
  let clients: Clients | undefined;
  const bound = (): Clients => {
    if (clients === undefined) {
      throw new ContractError('unavailable', 'usage is not activated.');
    }
    return clients;
  };

  return {
    implementation: {
      thread: ({ threadId }) => {
        const { usage, models } = bound();
        return routed(async () => {
          const { threadUsage } = await usage.read({ threadId });
          if (threadUsage === undefined) return {};
          return {
            threadUsage: await withContextCapacity(
              threadUsage,
              async (request) =>
                (await models.contextWindow(request)).contextWindow,
            ),
          };
        });
      },
      compact: ({ threadId }) => {
        const { threads } = bound();
        return routed(async () => {
          const outcome = await threads.compact({ id: threadId });
          return {
            status: outcome.status,
            ...(outcome.condensedMessages === undefined
              ? {}
              : { condensedMessages: outcome.condensedMessages }),
            ...(outcome.retainedMessages === undefined
              ? {}
              : { retainedMessages: outcome.retainedMessages }),
            ...(outcome.tokensFreed === undefined
              ? {}
              : { tokensFreed: outcome.tokensFreed }),
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            ...(outcome.code === undefined ? {} : { code: outcome.code }),
          };
        });
      },
      compactionTarget: () => {
        const { hostConfig } = bound();
        return routed(async () => {
          const configuration = await currentConfiguration(hostConfig);
          return {
            pressurePercent:
              configuration.execution?.contextCompaction?.pressurePercent ??
              defaultContextCompaction.pressurePercent,
          };
        });
      },
      setCompactionTarget: ({ pressurePercent }) => {
        const { hostConfig } = bound();
        return routed(async () => {
          const configuration = await currentConfiguration(hostConfig);
          const json = toJson(ConfigurationValueSchema, configuration, {
            alwaysEmitImplicit: true,
          }) as JsonObject;
          const execution = (json.execution ?? {}) as JsonObject;
          const section = (execution.contextCompaction as
            | JsonObject
            | undefined) ?? { ...defaultContextCompaction };
          const previous =
            configuration.execution?.contextCompaction?.pressurePercent ??
            defaultContextCompaction.pressurePercent;
          const replaced = await hostConfig.replace({
            input: fromJson(ValueSchema, {
              ...json,
              execution: {
                ...execution,
                contextCompaction: { ...section, pressurePercent },
              },
            }),
          });
          // A refused replace keeps the line the configuration still names.
          return {
            pressurePercent:
              replaced.status.case === 'replaced' ? pressurePercent : previous,
          };
        });
      },
    },
    activate: ({ services }) => {
      clients = {
        usage: services.use(RuntimeUsageService),
        threads: services.use(ThreadsService),
        hostConfig: services.use(HostConfigService),
        models: services.use(ModelsService),
      };
    },
  };
};
