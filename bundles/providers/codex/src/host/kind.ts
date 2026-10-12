import { codexMetadata, createCodexProvider } from 'llms';

import {
  baseUrl,
  endpointField,
  type KindDefinition,
  literalValue,
  tokenField,
} from './provider.js';

const fedrampValue = (
  value: string | undefined,
): { readonly fedramp?: boolean } => {
  if (value === undefined) return {};
  if (value !== 'true' && value !== 'false')
    throw new Error(`Provider value fedramp is not a flag: ${value}`);

  return { fedramp: value === 'true' };
};

/**
 * The llms `codex` kind, moved verbatim from the closed llms catalog. It is
 * kept for internal callers and not advertised.
 */
export const codexKind: KindDefinition = {
  kind: {
    id: 'codex',
    label: 'Codex',
    description:
      'The ChatGPT Codex Responses backend, authenticated with a Codex authorization value.',
    fields: [
      endpointField(codexMetadata.baseUrl),
      tokenField({
        required: true,
        description:
          'Names the stored API_TOKEN credential that carries the Codex authorization value.',
      }),
      {
        key: 'chatGptAccountId',
        label: 'ChatGPT account ID',
        kind: 'text',
        required: false,
        description:
          'The account id sent as ChatGPT-Account-ID beside the authorization value.',
      },
      {
        key: 'fedramp',
        label: 'FedRAMP',
        kind: 'enum',
        required: false,
        description: 'Sends X-OpenAI-Fedramp for a FedRAMP ChatGPT account.',
        placeholder: 'false',
        options: ['true', 'false'],
      },
    ],
    lists: [],
  },
  advertised: false,
  catalogCapacity: false,
  build: (values, deps) => {
    const chatGptAccountId = literalValue(
      'chatGptAccountId',
      values.chatGptAccountId,
    );

    return createCodexProvider({
      transport: deps.transport,
      logger: deps.logger,
      authorization: values.token ?? '',
      ...(chatGptAccountId === undefined ? {} : { chatGptAccountId }),
      ...fedrampValue(literalValue('fedramp', values.fedramp)),
      ...baseUrl(values),
    });
  },
};
