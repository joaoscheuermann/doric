import type { CatalogResult } from 'bundle/contracts';
import {
  claudeCatalogModel,
  claudeMetadata,
  createClaudeProvider,
  type HttpTransport,
  providerKind,
} from 'llms';
import type { Logger } from 'pino';

import {
  baseUrl,
  endpointField,
  type KindDefinition,
  tokenField,
} from './provider.js';

/** The `claude` kind: Anthropic Messages through a Claude Code subscription login. */
export const claudeKind: KindDefinition = {
  kind: {
    id: 'claude',
    label: 'Claude',
    description:
      'Anthropic Messages through a Claude Code subscription login, authenticated with a Claude authorization value.',
    fields: [
      endpointField(claudeMetadata.baseUrl),
      tokenField({
        required: true,
        description:
          'Names the stored API_TOKEN credential that carries the Claude authorization value: a Claude sign-in, a `claude setup-token` value, or a Console API key.',
      }),
    ],
    // The lists follow the llms kind, so the models and efforts the provider
    // learns to take reach the settings tables without a second copy here.
    lists: [...(providerKind('claude')?.lists ?? [])],
    // Every model the login may call is listed by Anthropic itself, so the
    // provider's models are that catalog and none is named by hand.
    modelsFromCatalog: providerKind('claude')?.modelsFromCatalog === true,
  },
  advertised: true,
  // `models()` reports each model's `max_input_tokens` as its context
  // window, so a Thread's context usage has the real capacity.
  catalogCapacity: true,
  build: (values, deps) =>
    createClaudeProvider({
      transport: deps.transport,
      logger: deps.logger,
      authorization: values.token ?? '',
      ...baseUrl(values),
    }),
  catalog: (input, deps) => readClaudeCatalog(input, deps),
};

/**
 * The models the stored login may call, read from Anthropic's `/v1/models`
 * through the provider itself, so the listing carries the same auth headers
 * and endpoint a request does. Without a login there is nothing to read
 * (`absent`); a refused or failed read is `failed`, and names nothing of the
 * endpoint, the credential or the response.
 */
export const readClaudeCatalog = async (
  input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly secret?: string;
  },
  deps: { readonly transport: HttpTransport; readonly logger: Logger },
): Promise<CatalogResult> => {
  const secret = input.secret ?? '';
  if (secret.trim() === '') return { status: 'absent' };

  try {
    const listed = await createClaudeProvider({
      transport: deps.transport,
      logger: deps.logger,
      authorization: secret,
      ...baseUrl(input.configuration),
    }).models();

    return {
      status: 'read',
      // Plain copies: llms `CatalogModel` is an interface, and the loose
      // bundle shape needs an object type.
      models: listed.map(claudeCatalogModel).map((model) => ({
        ...model,
        reasonings: [...model.reasonings],
        parameters: [...model.parameters],
      })),
    };
  } catch {
    return { status: 'failed' };
  }
};
