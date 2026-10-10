import {
  defineMethod,
  defineService,
  type ModelsProviderV1,
  modelsProviderMethods,
  toLanguageModel,
} from 'bundle/contracts';
import {
  createFetchTransport,
  createProviderForKind,
  type HttpTransport,
  modelCatalog,
  type ProviderKind,
  type ProviderValues,
  providerKinds,
  requestJson,
} from 'llms';
import type { Logger } from 'pino';

interface KindProviderOptions {
  readonly logger: () => Logger;
  readonly transport?: () => HttpTransport;
}

/**
 * The catalog URL a kind declares for a provider: the value an operator set,
 * or the kind's own default (`<endpoint>/models`, else the field's
 * placeholder). A kind without a `modelsUrl` field keeps no catalog.
 */
const catalogUrl = (
  kind: ProviderKind,
  configuration: Readonly<Record<string, string>>,
): string | undefined => {
  const field = kind.fields.find(({ key }) => key === 'modelsUrl');

  if (field === undefined) return undefined;

  return (
    configuration[field.key] ??
    (configuration.endpoint === undefined
      ? field.placeholder
      : `${configuration.endpoint}/models`)
  );
};

/**
 * One llms kind as a `models.provider/v1` record. `create` builds the llms
 * provider with the kind's values; the secret field reads the `secret`
 * callback, which llms awaits before every request, so a rotated credential
 * reaches the next request of a provider built before the rotation.
 */
export const createKindProvider = (
  contract: typeof ModelsProviderV1,
  kind: ProviderKind,
  options: KindProviderOptions,
) => {
  const transport = () => options.transport?.() ?? createFetchTransport();
  const secretField = kind.fields.find((field) => field.kind === 'secret');

  // By id: the llms kind and catalog shapes are readonly, which the typed
  // overload's mutable zod outputs refuse.
  return defineService(
    contract.id,
    {
      kind: defineMethod({
        ...modelsProviderMethods.kind,
        execute: () => Promise.resolve(kind),
      }),
      // llms advertises every kind but Codex, kept for internal callers.
      advertised: defineMethod({
        ...modelsProviderMethods.advertised,
        execute: () =>
          Promise.resolve(providerKinds.some(({ id }) => id === kind.id)),
      }),
      catalog: defineMethod({
        ...modelsProviderMethods.catalog,
        execute: async ({ configuration, secret }) => {
          const url = catalogUrl(kind, configuration);

          if (url === undefined) return { status: 'absent' as const };

          try {
            const response = await requestJson(transport(), kind.id, {
              method: 'GET',
              url,
              headers: {
                accept: 'application/json',
                ...(secret === undefined || secret === ''
                  ? {}
                  : { authorization: `Bearer ${secret}` }),
              },
            });

            return {
              status: 'read' as const,
              // Plain copies: llms `CatalogModel` is an interface, and the loose
              // bundle shape needs an object type.
              models: [...modelCatalog(response).values()].map((model) => ({
                ...model,
                reasonings: [...model.reasonings],
                parameters: [...model.parameters],
              })),
            };
          } catch {
            // The caller logs the failure; nothing here names the endpoint,
            // the credential or the response.
            return { status: 'failed' as const };
          }
        },
      }),
      create: defineMethod({
        ...modelsProviderMethods.create,
        execute: ({ providerId, values, secret }) => {
          const sources: Record<string, ProviderValues[string]> = {
            ...values,
          };

          if (secret !== undefined && secretField !== undefined) {
            sources[secretField.key] = secret;
          }

          return toLanguageModel(
            createProviderForKind(kind.id, sources, {
              transport: transport(),
              logger: options.logger(),
              identity: { id: providerId, name: providerId },
            }),
          );
        },
      }),
      // The runtime filled context capacity from OpenRouter's catalog alone
      // (usage-context.ts); models/v1.contextWindow keeps that rule.
      catalogCapacity: defineMethod({
        ...modelsProviderMethods.catalogCapacity,
        execute: () => Promise.resolve(kind.id === 'openrouter'),
      }),
    },
    { cardinality: 'many' },
  );
};
