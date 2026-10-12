import type { CatalogResult } from 'bundle/contracts';

/** One model a provider lists, with what its catalog says about it. */
export interface FillModel {
  readonly name: string;
  readonly reasonings?: readonly string[];
  readonly defaultEffort?: string;
  readonly mandatory?: boolean;
}

/** One configured provider whose model list a catalog read may describe. */
export interface FillProvider {
  readonly id: string;
  readonly kind: string;
  readonly configuration: Readonly<Record<string, string>>;
  readonly models?: readonly FillModel[];
}

/** The parts of a Doric configuration the catalog fill reads and writes. */
export interface FillConfiguration {
  readonly providers: readonly FillProvider[];
  readonly models: {
    readonly execution: {
      readonly providerId: string;
      readonly model: string;
      readonly effort?: string;
    };
  };
}

/** Reads one provider's catalog (`models/v1.catalog` for its kind and values). */
export type CatalogReader = (provider: FillProvider) => Promise<CatalogResult>;

/**
 * Writes what each provider's model catalog says about the models an operator
 * listed: the reasoning efforts each one accepts, the effort the catalog names
 * as the model's default, whether it pins reasoning on, and no efforts for a
 * model the catalog does not name. A catalog that cannot be read leaves that
 * provider exactly as it was, and a provider that lists no models is never
 * read. The execution profile is then resolved against the model it names
 * (`executionProfile`).
 */
export const readModelProperties = async <C extends FillConfiguration>(
  configuration: C,
  read: CatalogReader,
): Promise<C> => {
  const providers = await Promise.all(
    configuration.providers.map(
      async (provider) => (await withCatalog(provider, read)) ?? provider,
    ),
  );

  return {
    ...configuration,
    providers,
    models: executionProfile(providers, configuration),
  };
};

/** One provider's models as its catalog describes them, or `undefined` keeping it. */
const withCatalog = async <P extends FillProvider>(
  provider: P,
  read: CatalogReader,
): Promise<P | undefined> => {
  if ((provider.models?.length ?? 0) === 0) return undefined;

  const result = await read(provider);

  if (result.status !== 'read') return undefined;

  const catalog = new Map(result.models.map((model) => [model.id, model]));

  return {
    ...provider,
    models: provider.models?.map((model) => {
      const entry = catalog.get(model.name.trim());

      return {
        name: model.name,
        reasonings: [...(entry?.reasonings ?? [])],
        ...(entry?.defaultEffort === undefined
          ? {}
          : { defaultEffort: entry.defaultEffort }),
        ...(entry?.mandatory === true ? { mandatory: true } : {}),
      };
    }),
  };
};

/**
 * The execution profile resolved against the model it names. An effort the
 * operator named is kept, `none` included. A profile that names none takes
 * the catalog's default effort for the model, else its first effort other
 * than `none`. A model that lists no effort leaves the profile with none, and
 * a kind that keeps no reasonings leaves the profile as it was.
 */
export const executionProfile = (
  providers: readonly FillProvider[],
  configuration: FillConfiguration,
): FillConfiguration['models'] => {
  const { providerId, model, effort } = configuration.models.execution;
  const listed = providers
    .find((provider) => provider.id === providerId)
    ?.models?.find((entry) => entry.name === model);

  if (listed?.reasonings === undefined) return configuration.models;

  const efforts = listed.reasonings;
  if (efforts.length === 0) return { execution: { providerId, model } };

  if (effort !== undefined) return configuration.models;

  const preferred = listed.defaultEffort;
  const start =
    preferred !== undefined && efforts.includes(preferred)
      ? preferred
      : (efforts.find((value) => value !== 'none') ?? efforts[0]);

  return { execution: { providerId, model, effort: start } };
};
