import { createOpenAiProvider, modelNameIcon, openAiMetadata } from 'llms';

import {
  baseUrl,
  endpointField,
  type KindDefinition,
  tokenField,
} from './provider.js';

const openAiOrigin = new URL(openAiMetadata.baseUrl).origin;

/** Whether an `openai` provider talks to OpenAI itself rather than a compatible server. */
const isOpenAiEndpoint = (endpoint: string | undefined): boolean => {
  const value = (endpoint ?? '').trim();
  if (value === '') return true;

  try {
    return new URL(value).origin === openAiOrigin;
  } catch {
    return false;
  }
};

/** The llms `openai` kind, moved verbatim from the closed llms catalog. */
export const openAiKind: KindDefinition = {
  kind: {
    id: 'openai',
    label: 'OpenAI',
    description:
      'Any endpoint that answers the OpenAI Responses API, under its own identity.',
    fields: [
      endpointField(openAiMetadata.baseUrl),
      tokenField({
        required: false,
        description:
          'Names the stored API_TOKEN credential to authenticate with. Absent leaves the auth header off, which a compatible endpoint may accept.',
      }),
    ],
    lists: ['models', 'reasonings'],
  },
  advertised: true,
  catalogCapacity: false,
  build: (values, deps) =>
    createOpenAiProvider({
      transport: deps.transport,
      logger: deps.logger,
      identity: deps.identity,
      apiKey: values.token ?? '',
      ...baseUrl(values),
    }),
  icons: ({ configuration, models }) =>
    isOpenAiEndpoint(configuration.endpoint)
      ? { provider: 'openai', models: models.map(() => 'openai') }
      : { models: models.map((model) => modelNameIcon(model)) },
};
