import type { CatalogResult } from 'bundle/contracts';
import {
  type HttpTransport,
  modelCatalog,
  openRouterMetadata,
  requestJson,
} from 'llms';

/**
 * The catalog URL for a provider: the value an operator set, else
 * `<endpoint>/models`, else the kind's own default.
 */
export const catalogUrl = (
  configuration: Readonly<Record<string, string>>,
): string =>
  configuration.modelsUrl ??
  (configuration.endpoint === undefined
    ? `${openRouterMetadata.baseUrl}/models`
    : `${configuration.endpoint}/models`);

/**
 * Reads the provider's live catalog, with the secret as a bearer token when it
 * is not empty. A failed read is `failed`; the caller logs it, and nothing here
 * names the endpoint, the credential or the response.
 */
export const readCatalog = async (
  input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly secret?: string;
  },
  transport: HttpTransport,
): Promise<CatalogResult> => {
  const { secret } = input;

  try {
    const response = await requestJson(transport, 'openrouter', {
      method: 'GET',
      url: catalogUrl(input.configuration),
      headers: {
        accept: 'application/json',
        ...(secret === undefined || secret === ''
          ? {}
          : { authorization: `Bearer ${secret}` }),
      },
    });

    return {
      status: 'read',
      // Plain copies: llms `CatalogModel` is an interface, and the loose
      // bundle shape needs an object type.
      models: [...modelCatalog(response).values()].map((model) => ({
        ...model,
        reasonings: [...model.reasonings],
        parameters: [...model.parameters],
      })),
    };
  } catch {
    return { status: 'failed' };
  }
};
