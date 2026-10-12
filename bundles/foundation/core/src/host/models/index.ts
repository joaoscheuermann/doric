import {
  type CatalogResult,
  defineMethod,
  defineService,
  LogV1,
  type ModelRequest,
  ModelsProviderV1,
  ModelsV1,
  modelsMethods,
  SecretsV1,
  type Services,
} from 'bundle/contracts';

import { contextWindow } from './capacity.js';
import { type ConfiguredProvider, createProviderCache } from './providers.js';
import { createKindRegistry } from './registry.js';

/** A stored credential's secret, or `undefined` when none is stored under the id. */
const storedSecret = async (
  services: Services,
  id: string,
): Promise<string | undefined> => {
  try {
    return (await services.use(SecretsV1).resolve({ id })).secret;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The providers and the revision of what `prepare` received: a stored
 * snapshot (`{ configuration, revision, updatedAt }`) or a bare configuration
 * a replacement is about to store.
 */
const preparedOf = (
  input: Readonly<Record<string, unknown>>,
): {
  readonly providers: readonly ConfiguredProvider[];
  readonly revision: number | undefined;
} => {
  const stored =
    typeof input.revision === 'number' && isRecord(input.configuration);
  const configuration = stored
    ? (input.configuration as Record<string, unknown>)
    : input;
  const providers = configuration.providers;

  if (!Array.isArray(providers)) {
    throw new Error('The configuration lists no providers.');
  }

  return {
    providers: providers.map((provider: unknown) => {
      if (
        !isRecord(provider) ||
        typeof provider.id !== 'string' ||
        typeof provider.kind !== 'string' ||
        !isRecord(provider.configuration)
      ) {
        throw new Error('A configured provider is invalid.');
      }

      const models = Array.isArray(provider.models)
        ? provider.models.flatMap((model: unknown) =>
            isRecord(model) && typeof model.name === 'string'
              ? [model.name]
              : [],
          )
        : undefined;

      return {
        id: provider.id,
        kind: provider.kind,
        configuration: provider.configuration as Record<string, string>,
        ...(models === undefined ? {} : { models }),
      };
    }),
    revision: stored ? (input.revision as number) : undefined,
  };
};

/**
 * The core's `models/v1` over the `models.provider/v1` records. Activation
 * starts listening for the records; nothing is built until `prepare`.
 */
export const createModels = (services: Services) => {
  const registry = createKindRegistry((api) => cache.forget(api));
  const cache = createProviderCache(
    registry,
    async (id) => (await storedSecret(services, id)) ?? '',
  );

  services.whenAvailable(ModelsProviderV1, (api) => registry.add(api));

  // By id: `kind` takes a one-item tuple, which the typed overload reads as a
  // single `string` input.
  return defineService(ModelsV1.id, {
    resolve: defineMethod({
      ...modelsMethods.resolve,
      execute: async ({ providerId, model, effort }: ModelRequest) => ({
        providerId,
        model,
        ...(effort === undefined ? {} : { effort }),
        languageModel: await cache.resolve(providerId),
      }),
    }),
    kinds: defineMethod({
      ...modelsMethods.kinds,
      execute: async () =>
        (await registry.entries())
          .filter(({ advertised }) => advertised)
          .map(({ kind }) => kind),
    }),
    kind: defineMethod({
      ...modelsMethods.kind,
      execute: async ([id]: [string]) => (await registry.find(id))?.kind,
    }),
    catalog: defineMethod({
      ...modelsMethods.catalog,
      execute: async (
        { kind, configuration },
        call,
      ): Promise<CatalogResult> => {
        const entry = await registry.find(kind);

        // A kind no record provides keeps no catalog, as before.
        if (entry === undefined) return { status: 'absent' };

        const field = entry.kind.fields.find(
          (candidate) => candidate.kind === 'secret',
        );
        const id = field === undefined ? undefined : configuration[field.key];
        const secret =
          id === undefined ? undefined : await storedSecret(services, id);
        const result = await entry.api
          .catalog({
            configuration,
            ...(secret === undefined ? {} : { secret }),
          })
          .catch((): CatalogResult => ({ status: 'failed' }));

        if (result.status === 'failed') {
          // Never the endpoint, the credential or the response.
          services
            .use(LogV1)
            .warn('Model catalog could not be read', { kind }, call);
        }

        return result;
      },
    }),
    prepare: defineMethod({
      ...modelsMethods.prepare,
      execute: async (input) => {
        const { providers, revision } = preparedOf(input);

        await cache.prepare(providers, revision);
      },
    }),
    contextWindow: defineMethod({
      ...modelsMethods.contextWindow,
      execute: (request) => contextWindow(registry, cache, request),
    }),
  });
};
