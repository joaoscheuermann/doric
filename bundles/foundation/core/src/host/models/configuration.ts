// The models configuration as `models/v1.Prepare` receives it.

import type { ConfiguredProvider } from './providers.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The providers and the revision of what `prepare` received: a stored
 * snapshot (`{ configuration, revision, updatedAt }`) or a bare configuration
 * a replacement is about to store. Throws an `Error` when the configuration
 * lists no providers or a provider is malformed.
 */
export const preparedOf = (
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
