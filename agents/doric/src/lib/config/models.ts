import {
  type CatalogModel,
  createFetchTransport,
  type HttpTransport,
  modelCatalog,
  providerKind,
  requestJson,
} from 'llms';
import type { Logger } from 'pino';

import type { CredentialService } from '../credentials/service.js';
import {
  type ConfigInput,
  type ProviderValuesRef,
  providerCredentials,
} from './schema.js';

/** One provider the configuration carries. */
type Provider = ConfigInput['providers'][number];

/**
 * The provider a catalog is read for. The provider page asks before any of the
 * provider's models exist, so the id is the draft's and may still be unset — the
 * kind and the values are what the read needs.
 */
type CatalogProvider = ProviderValuesRef;

interface CatalogOptions {
  readonly credentials: CredentialService;
  readonly logger: Logger;
  /** Injected so a test never reaches a real endpoint. */
  readonly transport?: HttpTransport;
}

/**
 * What one read of a provider's model catalog found. A kind that declares no
 * catalog URL keeps none, and a catalog that could not be read is told apart from
 * one that describes nothing, because a page shows the first as a missing feature
 * and the second as a failure.
 */
export type CatalogRead =
  | { readonly status: 'read'; readonly models: readonly CatalogModel[] }
  | { readonly status: 'absent' }
  | { readonly status: 'failed' };

/**
 * The models one provider's catalog lists, as the endpoint describes them: what
 * each is called, the efforts it accepts, and what it advertises. A kind that
 * declares no models URL is `absent`, and a catalog the host cannot read is
 * `failed` — never an empty list, which would mean the endpoint listed nothing.
 */
export const readCatalogEntries = async (
  provider: CatalogProvider,
  { credentials, logger, transport }: CatalogOptions,
): Promise<CatalogRead> => {
  const kind = providerKind(provider.kind);
  const url = catalogUrl(provider);

  if (kind === undefined || url === undefined) return { status: 'absent' };

  const secret = credential(provider, credentials);

  try {
    const response = await requestJson(
      transport ?? createFetchTransport(),
      kind.id,
      {
        method: 'GET',
        url,
        headers: {
          accept: 'application/json',
          ...(secret === undefined || secret === ''
            ? {}
            : { authorization: `Bearer ${secret}` }),
        },
      },
    );

    return { status: 'read', models: [...modelCatalog(response).values()] };
  } catch {
    // The catalog is a best effort: no prompt depends on it, and the failure must
    // never name the endpoint, the credential, or the response in a log line.
    logger.warn(
      provider.id === undefined
        ? { kind: provider.kind }
        : { providerId: provider.id },
      'Model catalog could not be read',
    );

    return { status: 'failed' };
  }
};

/**
 * Writes what each provider's model catalog says about the models an operator
 * listed: the reasoning efforts each one accepts, the effort the catalog names as
 * the model's default, whether it pins reasoning on, and no efforts for a model
 * the catalog does not name. A catalog a host cannot read leaves that provider
 * exactly as it was rather than erasing what it already knew, and a model list no
 * kind reads a catalog for is untouched.
 *
 * The execution effort is resolved against the model it names: an effort the
 * operator chose is kept, a profile that names none starts at the effort its
 * model starts at, and a model that lists none leaves the profile with none, so
 * no prompt sends an effort the endpoint never offered and no thinking model is
 * left asking for no reasoning at all.
 */
export const readModelProperties = async (
  configuration: ConfigInput,
  options: CatalogOptions,
): Promise<ConfigInput> => {
  const providers = await Promise.all(
    configuration.providers.map(
      async (provider) => (await withCatalog(provider, options)) ?? provider,
    ),
  );

  return {
    ...configuration,
    providers,
    models: executionProfile(providers, configuration),
  };
};

/** One provider's models as its catalog describes them, or `undefined` keeping it. */
const withCatalog = async (
  provider: Provider,
  options: CatalogOptions,
): Promise<Provider | undefined> => {
  // Nothing to describe: a provider that lists no models is left alone, so the
  // read never happens for the sake of an empty list.
  if ((provider.models?.length ?? 0) === 0) return undefined;

  const read = await readCatalogEntries(provider, options);

  if (read.status !== 'read') return undefined;

  const catalog = new Map(read.models.map((model) => [model.id, model]));

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
 * The catalog URL a provider's kind declares for it: the value an operator set,
 * or the kind's own default, which travels as the field's placeholder.
 */
const catalogUrl = (provider: CatalogProvider): string | undefined => {
  const field = providerKind(provider.kind)?.fields.find(
    ({ key }) => key === 'modelsUrl',
  );

  if (field === undefined) return undefined;

  return provider.configuration[field.key] ?? field.placeholder;
};

/** The secret the provider authenticates its catalog read with, when it has one. */
const credential = (
  provider: CatalogProvider,
  credentials: CredentialService,
): string | undefined => {
  const named = providerCredentials(provider)[0];

  return named === undefined ? undefined : credentials.find(named.id)?.secret;
};

/**
 * The execution profile resolved against the model it names. A profile that names
 * an effort is kept as it stands, because that is the operator's choice, including
 * the `none` that asks for no reasoning. A profile that names none takes the
 * effort its model starts at — the one the catalog names as the model's default,
 * and otherwise the model's first effort other than `none` — so a thinking model
 * is never left with no effort at all. A model that lists no effort leaves the
 * profile with none, because there is nothing the request could carry for it.
 */
const executionProfile = (
  providers: readonly Provider[],
  configuration: ConfigInput,
): ConfigInput['models'] => {
  const { providerId, model, effort } = configuration.models.execution;
  const listed = providers
    .find((provider) => provider.id === providerId)
    ?.models?.find((entry) => entry.name === model);

  // A kind that keeps no reasonings says nothing about this model's.
  if (listed?.reasonings === undefined) return configuration.models;

  const efforts = listed.reasonings;
  if (efforts.length === 0) return { execution: { providerId, model } };

  // An effort the operator named is theirs, including the `none` that asks for
  // no reasoning; a profile that names none starts where the model starts.
  if (effort !== undefined) return configuration.models;

  const preferred = listed.defaultEffort;
  const start =
    preferred !== undefined && efforts.includes(preferred)
      ? preferred
      : (efforts.find((value) => value !== 'none') ?? efforts[0]);

  return { execution: { providerId, model, effort: start } };
};
