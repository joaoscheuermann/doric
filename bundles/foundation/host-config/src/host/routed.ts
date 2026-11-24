// The router clients `host-config`'s routed services read and write through
// (phase 3, slice S45): the configuration space over `settings/v1`, and the
// credentials, tools and models a replacement is checked against.

import {
  fromJson,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';
import { type Any, anyPack, anyUnpack } from '@bufbuild/protobuf/wkt';
import { type Client, ConnectError } from '@connectrpc/connect';
import {
  type CatalogResult,
  ContractError,
  catalogResultSchema,
  fromConnectError,
  type Models,
  modelKindDescriptorSchema,
} from 'bundle/contracts';
import {
  CatalogResultSchema,
  ModelKindDescriptorSchema,
} from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';
import type { ModelsService } from 'bundle/contracts/gen/doric/models/v1/models_pb.js';
import type { SecretsService } from 'bundle/contracts/gen/doric/secrets/v1/secrets_pb.js';
import type { SettingsService } from 'bundle/contracts/gen/doric/settings/v1/settings_pb.js';
import type { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { providerKind } from 'llms';

import { ConfigurationValueSchema } from '../contracts/gen/doric/host_config/configuration/v1/configuration_pb.js';
import { type ConfigInput, ConfigInputSchema } from './config/schema.js';
import type { ConfigSpace } from './config/store.js';
import type { ToolFields } from './config/tool-config.js';

/** A router call's failure as its Doric error; any other error unchanged. */
export const contractError = (error: unknown): unknown =>
  error instanceof ConnectError ? fromConnectError(error) : error;

/** Awaits a router call, rejecting with its Doric error. */
export const called = async <T>(request: Promise<T>): Promise<T> => {
  try {
    return await request;
  } catch (error) {
    throw contractError(error);
  }
};

/** `value` as JSON, through `JSON.stringify` (what a `Struct` carries). */
export const asJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

/** `value`, a JSON object, as a `Struct`'s JSON. */
const asJsonObject = (value: unknown): JsonObject => {
  const json = asJson(value);

  if (json === null || typeof json !== 'object' || Array.isArray(json))
    throw new TypeError('Expected a JSON object.');

  return json;
};

/** A configuration as the `Any` of `ConfigurationValue` the space stores. */
export const packConfiguration = (value: ConfigInput): Any =>
  anyPack(
    ConfigurationValueSchema,
    fromJson(ConfigurationValueSchema, asJson(value)),
  );

/**
 * `json`, a configuration's JSON with every implicit field emitted, without the
 * lists a provider's kind does not keep: proto3 cannot tell an absent list from
 * an empty one, so the kind decides. A kind the catalog does not know keeps its
 * lists, for the schema to refuse.
 */
const withoutUnkeptLists = (json: JsonValue): JsonValue => {
  if (json === null || typeof json !== 'object' || Array.isArray(json))
    return json;

  const { providers } = json;

  if (!Array.isArray(providers)) return json;

  return {
    ...json,
    providers: providers.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
        return entry;

      const kind =
        typeof entry.kind === 'string' ? providerKind(entry.kind) : undefined;

      if (kind === undefined) return entry;

      const { models, ...rest } = entry;

      if (!kind.lists.includes('models')) return rest;
      if (kind.lists.includes('reasonings') || !Array.isArray(models))
        return entry;

      return {
        ...rest,
        models: models.map((model) => {
          if (
            model === null ||
            typeof model !== 'object' ||
            Array.isArray(model)
          )
            return model;

          const { reasonings: _unkept, ...kept } = model;
          return kept;
        }),
      };
    }),
  };
};

/**
 * The configuration an `Any` of `ConfigurationValue` holds. Every implicit
 * field is read, so an empty `models` or `reasonings` list reads as `[]` where
 * the provider's kind keeps that list, and is absent where it does not.
 */
export const unpackConfiguration = (value: Any | undefined): ConfigInput => {
  const message =
    value === undefined
      ? undefined
      : anyUnpack(value, ConfigurationValueSchema);

  if (message === undefined)
    throw new ContractError(
      'internal',
      'The configuration space does not hold a ConfigurationValue.',
    );

  return ConfigInputSchema.parse(
    withoutUnkeptLists(
      toJson(ConfigurationValueSchema, message, { alwaysEmitImplicit: true }),
    ),
  );
};

/** The configuration space `id` over `settings/v1`. */
export const routedSpace = (
  settings: Client<typeof SettingsService>,
  id: string,
): ConfigSpace => {
  const entryOf = (
    entry: { value?: Any; revision: number; updatedAt: string } | undefined,
  ) => {
    if (entry === undefined)
      throw new ContractError('internal', 'settings/v1 answered no entry.');

    return {
      value: unpackConfiguration(entry.value),
      revision: entry.revision,
      updatedAt: entry.updatedAt,
    };
  };

  return {
    entry: async () =>
      entryOf((await called(settings.entry({ id }))).settingsEntry),
    set: async (value) =>
      entryOf(
        (await called(settings.set({ id, value: packConfiguration(value) })))
          .settingsEntry,
      ),
  };
};

/** The stored credentials by id, from one `secrets/v1.List`. */
export const routedCredentials =
  (secrets: Client<typeof SecretsService>) =>
  async (): Promise<{ find(id: string): { kind: string } | undefined }> => {
    const { credentials } = await called(secrets.list({}));
    const kinds = new Map(credentials.map(({ id, kind }) => [id, kind]));

    return {
      find: (id) => {
        const kind = kinds.get(id);

        return kind === undefined ? undefined : { kind };
      },
    };
  };

/** The registered tools' configuration fields, from `tools/v1.List`. */
export const routedTools =
  (tools: Client<typeof ToolsService>) =>
  async (): Promise<readonly ToolFields[]> => {
    const listed = await called(tools.list({}));

    return listed.tools.flatMap(({ tool }) =>
      tool === undefined
        ? []
        : [
            {
              name: tool.name,
              settings: tool.settings.map((field) => ({
                key: typeof field.key === 'string' ? field.key : '',
                ...(typeof field.default === 'string'
                  ? { default: field.default }
                  : {}),
                ...(typeof field.required === 'boolean'
                  ? { required: field.required }
                  : {}),
              })),
            },
          ],
    );
  };

/** `models/v1`'s kinds, catalog reads and provider builds. */
export const routedModels = (
  models: Client<typeof ModelsService>,
): Pick<Models, 'catalog' | 'kind' | 'prepare'> => ({
  kind: async (id) => {
    const { modelKindDescriptor } = await called(models.kind({ id }));

    return modelKindDescriptor === undefined
      ? undefined
      : modelKindDescriptorSchema.parse(
          toJson(ModelKindDescriptorSchema, modelKindDescriptor, {
            alwaysEmitImplicit: true,
          }),
        );
  },
  catalog: async ({ kind, configuration }): Promise<CatalogResult> => {
    const { catalogResult } = await called(
      models.catalog({ kind, configuration: { ...configuration } }),
    );

    if (catalogResult === undefined) return { status: 'failed' };
    if (catalogResult.status !== 'read')
      return catalogResultSchema.parse({ status: catalogResult.status });

    return catalogResultSchema.parse(
      toJson(CatalogResultSchema, catalogResult, { alwaysEmitImplicit: true }),
    );
  },
  prepare: async (configuration) => {
    await called(
      models.prepare({ configuration: asJsonObject(configuration) }),
    );
  },
});
