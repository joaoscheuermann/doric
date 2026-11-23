// `host-config`'s host part over the router (phase 3, slice S45):
// `host-config/v1` and the settings space `host-config.configuration/v1`,
// with the space's reference source and the configuration start step.

import { AsyncLocalStorage } from 'node:async_hooks';

import { fromJson, type MessageInitShape, toJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';
import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError, isContractError } from 'bundle/contracts';
import { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import {
  type ReferenceSourceService,
  SecretsService,
} from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { type HookHandlers, type HostContext, onHostStart } from 'bundle/host';

import type {
  ConfigReplaceResult,
  DoricConfiguration,
} from '../contracts/index.js';
import {
  DoricConfigurationSchema,
  type HostConfigService,
  type ReplaceResponseSchema,
} from '../contracts/gen/doric/host_config/v1/host_config_pb.js';
import { ConfigInputSchema } from './config/schema.js';
import { type ConfigService, createConfigService } from './config/service.js';
import { createSpaceConfigStore } from './config/store.js';
import { referencedCredentialIds } from './configuration.js';
import {
  asJson,
  called,
  contractError,
  routedCredentials,
  routedModels,
  routedSpace,
  routedTools,
  unpackConfiguration,
} from './routed.js';

/** The settings id of the configuration space. */
export const CONFIGURATION_SETTINGS_ID = 'host-config.configuration/v1';
/** The full name of the space's value message. */
export const CONFIGURATION_MESSAGE_TYPE =
  'doric.host_config.configuration.v1.ConfigurationValue';
/** The name of host-config's reference source (`secrets/v1`). */
export const CONFIGURATION_REFERENCE_SOURCE = 'configuration';

/** Each service `main.ts` lists, by name. */
export interface HostConfigImplementations {
  /**
   * `host-config/v1`. It gives today's answers (`createConfigService`) over
   * the router.
   *
   * `Current{}` answers `{doricConfiguration}`, the stored configuration
   * with its revision and update time:
   * - read once with `settings/v1.Entry{id: CONFIGURATION_SETTINGS_ID}`,
   *   then kept;
   * - read again by the next call when the read failed;
   * - converted as in the contract's §2.4, so its JSON is today's
   *   `GET /config` body.
   *
   * `Replace{input}` runs today's pipeline, serialized in request order:
   * 1. schema (`ConfigInputSchema`); a failure answers `invalid` "The Doric
   *    configuration is invalid.";
   * 2. credentials, by one `secrets/v1.List` (kind by id); a missing or
   *    mis-kinded credential answers `invalid` with today's message;
   * 3. catalog fill: `models/v1.Kind` and `Catalog`;
   * 4. tool fields, from `tools/v1.List`'s `tool.settings` (an unsatisfied
   *    required field answers `invalid` "Tool <name> requires a <key>
   *    value.");
   * 5. `models/v1.Prepare` of the candidate;
   * 6. `settings/v1.Set`;
   * 7. `models/v1.Prepare` of the stored snapshot.
   *
   * It answers `replaced{config}`, or `rejected{}` for any failure after
   * step 1 that is not a credential or tool fault; the active configuration
   * is then unchanged. Each router call inherits the `Replace` call.
   *
   * Both RPCs fail with:
   * - `unavailable` before `activate` ran;
   * - `Current`: the `Entry` call's `ContractError` (`settings_missing` when
   *   the space was never written).
   */
  readonly hostConfig: ServiceImpl<typeof HostConfigService>;
  /**
   * `ReferenceSourceService.List{source}`, called by `secrets/v1`'s
   * provider under its write lock before a credential is deleted.
   *
   * It answers each credential id once, from two sources:
   * - the ids that the stored configuration references, read at every call
   *   with `settings/v1.Get{id: CONFIGURATION_SETTINGS_ID}`: each provider's
   *   `secret` fields, `gitCredentialId` and `githubCredentialId`
   *   (`referencedCredentialIds`);
   * - the ids of each `Replace` in progress, from the start of its credential
   *   check until its `Set` settled.
   *
   * So a credential cannot be deleted between a replacement's check and
   * its write.
   *
   * - The stored configuration contributes no id when `Get` fails with
   *   `settings_missing` or `unknown_settings`. It fails with any other
   *   error of `Get`, so the `Delete` fails and deletes nothing.
   * - A `source` other than `CONFIGURATION_REFERENCE_SOURCE` answers no ids.
   * - Fails with `unavailable` before `activate` ran.
   */
  readonly references: ServiceImpl<typeof ReferenceSourceService>;
}

export interface HostConfigServices {
  /** Built at load with no I/O; bound to the instance by `activate`. */
  readonly implementations: HostConfigImplementations;
  /**
   * Binds the services to `context` and makes the bundle's registrations
   * in this order:
   * 1. `context.registrations.track(SettingsService, …)` with
   *    `settings/v1.Register{id: CONFIGURATION_SETTINGS_ID, messageType:
   *    CONFIGURATION_MESSAGE_TYPE}`;
   * 2. `context.registrations.track(SecretsService, …)` with
   *    `secrets/v1.RegisterReferences{source:
   *    CONFIGURATION_REFERENCE_SOURCE}`;
   * 3. `onHostStart(hooks, context, …)`, the start step below.
   *
   * It reads no configuration. It rejects with the first failing call's
   * `ContractError`, which fails `ActivateResult`.
   *
   * The start step, under the host's `onHostStartHook` run:
   * 1. `Stage('configuration_activation')`;
   * 2. `Log('info', 'Activating Doric configuration', {})`;
   * 3. `Current`'s read of the stored configuration;
   * 4. `models/v1.Prepare{configuration: <the snapshot as JSON:
   *    {configuration, revision, updatedAt}>}`;
   * 5. `Log('info', 'Doric configuration activated', {configRevision,
   *    providerCount, executionModel, maxTurns})`, with today's values.
   *
   * Any step's failure fails the run with its `ContractError`, and the later
   * steps do not run.
   */
  activate(context: HostContext, hooks: HookHandlers): Promise<void>;
}

/** Creates `host-config`'s routed services. No I/O; never throws. */
export const createHostConfigServices = (): HostConfigServices => {
  /** What `activate` bound: the instance's clients and the config service. */
  let bound:
    | {
        readonly context: HostContext;
        readonly service: ConfigService;
      }
    | undefined;

  /**
   * The credential ids of each replacement between the start of its
   * credential check and the end of its write.
   */
  const inflight = new Set<{ readonly ids: readonly string[] }>();
  /** The replacement a pipeline step runs for. */
  const replacing = new AsyncLocalStorage<{
    readonly ids: readonly string[];
  }>();

  const activated = () => {
    if (bound === undefined)
      throw new ContractError('unavailable', 'host-config is not activated.');

    return bound;
  };

  const doricConfiguration = (snapshot: DoricConfiguration) =>
    fromJson(DoricConfigurationSchema, asJson(snapshot));

  const replaceResponse = (
    result: ConfigReplaceResult,
  ): MessageInitShape<typeof ReplaceResponseSchema> => {
    switch (result.status) {
      case 'replaced':
        return {
          status: {
            case: 'replaced',
            value: { config: doricConfiguration(result.config) },
          },
        };
      case 'invalid':
        return {
          status: { case: 'invalid', value: { message: result.message } },
        };
      case 'rejected':
        return { status: { case: 'rejected', value: {} } };
    }
  };

  const bind = (context: HostContext): ConfigService => {
    const settings = context.services.use(SettingsService);
    const space = routedSpace(settings, CONFIGURATION_SETTINGS_ID);
    const credentials = routedCredentials(context.services.use(SecretsService));
    const replacement = () => replacing.getStore();

    return createConfigService({
      store: createSpaceConfigStore({
        entry: () => space.entry(),
        set: async (value) => {
          const current = replacement();

          try {
            return await space.set(value);
          } finally {
            if (current !== undefined) inflight.delete(current);
          }
        },
      }),
      credentials: () => {
        const current = replacement();

        if (current !== undefined) inflight.add(current);

        return credentials();
      },
      tools: routedTools(context.services.use(ToolsService)),
      models: routedModels(context.services.use(ModelsService)),
    });
  };

  /** The ids the stored configuration references; none when never written. */
  const storedIds = async (context: HostContext): Promise<string[]> => {
    try {
      const { value } = await context.services
        .use(SettingsService)
        .get({ id: CONFIGURATION_SETTINGS_ID });

      return referencedCredentialIds(unpackConfiguration(value));
    } catch (error) {
      const failure = contractError(error);

      if (
        isContractError(failure) &&
        (failure.code === 'settings_missing' ||
          failure.code === 'unknown_settings')
      )
        return [];

      throw failure;
    }
  };

  return {
    implementations: {
      hostConfig: {
        current: async () => ({
          doricConfiguration: doricConfiguration(
            await activated().service.current(),
          ),
        }),
        replace: async ({ input }) => {
          const { service } = activated();
          const body =
            input === undefined ? undefined : toJson(ValueSchema, input);
          const parsed = ConfigInputSchema.safeParse(body);

          if (!parsed.success)
            return replaceResponse(await service.replace(body));

          const current = { ids: referencedCredentialIds(parsed.data) };

          // The config service's lane serializes the replacements in request
          // order; its queued step keeps this replacement's store.
          return replaceResponse(
            await replacing
              .run(current, () => service.replace(body))
              .finally(() => inflight.delete(current)),
          );
        },
      },
      references: {
        list: async ({ source }) => {
          const { context } = activated();

          if (source !== CONFIGURATION_REFERENCE_SOURCE)
            return { credentialIds: [] };

          const ids = new Set(await storedIds(context));

          for (const { ids: pending } of inflight)
            for (const id of pending) ids.add(id);

          return { credentialIds: [...ids] };
        },
      },
    },

    activate: async (context, hooks) => {
      const service = bind(context);

      bound = { context, service };

      await context.registrations.track(SettingsService, (client) =>
        called(
          client.register({
            id: CONFIGURATION_SETTINGS_ID,
            messageType: CONFIGURATION_MESSAGE_TYPE,
          }),
        ),
      );
      await context.registrations.track(SecretsService, (client) =>
        called(
          client.registerReferences({ source: CONFIGURATION_REFERENCE_SOURCE }),
        ),
      );
      await onHostStart(hooks, context, async (startup) => {
        await startup.stage('configuration_activation');
        await startup.log('info', 'Activating Doric configuration', {});

        const snapshot = await service.current();

        await routedModels(context.services.use(ModelsService)).prepare({
          ...snapshot,
        });
        await startup.log('info', 'Doric configuration activated', {
          configRevision: snapshot.revision,
          providerCount: snapshot.configuration.providers.length,
          executionModel: asJson(snapshot.configuration.models.execution),
          maxTurns: snapshot.configuration.execution.maxTurns,
        });
      });
    },
  };
};
