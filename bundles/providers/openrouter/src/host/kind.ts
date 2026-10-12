import {
  createOpenRouterProvider,
  defaultStructuredOutputRepairs,
  openRouterMetadata,
} from 'llms';

import { readCatalog } from './catalog.js';
import {
  baseUrl,
  endpointField,
  type KindDefinition,
  literalValue,
  tokenField,
} from './provider.js';

const numericValue = (key: string, value: string): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed))
    throw new Error(`Provider value ${key} is not a number: ${value}`);

  return parsed;
};

/**
 * The llms `openrouter` kind, moved verbatim from the closed llms catalog. Its
 * live catalog reports context windows, which usage reads as capacity.
 */
export const openRouterKind: KindDefinition = {
  kind: {
    id: 'openrouter',
    label: 'OpenRouter',
    description:
      'OpenRouter Chat Completions with curated model profiles, live capability discovery, and structured-output repair.',
    fields: [
      endpointField(openRouterMetadata.baseUrl),
      tokenField({
        required: true,
        description:
          'Names the stored API_TOKEN credential this provider authenticates with.',
      }),
      {
        key: 'maxStructuredOutputRepairs',
        label: 'Structured output repairs',
        kind: 'number',
        required: false,
        advanced: true,
        description:
          'How many corrected attempts a rejected structured response gets.',
        placeholder: String(defaultStructuredOutputRepairs),
      },
      {
        key: 'modelsUrl',
        label: 'Models URL',
        kind: 'url',
        required: false,
        advanced: true,
        description:
          'Where this provider lists the models it serves and what each one accepts.',
        placeholder: `${openRouterMetadata.baseUrl}/models`,
      },
    ],
    lists: ['models', 'reasonings'],
  },
  advertised: true,
  catalogCapacity: true,
  build: (values, deps) => {
    const repairs = literalValue(
      'maxStructuredOutputRepairs',
      values.maxStructuredOutputRepairs,
    );

    return createOpenRouterProvider({
      transport: deps.transport,
      logger: deps.logger,
      apiKey: values.token ?? '',
      modelsUrl: literalValue('modelsUrl', values.modelsUrl),
      ...(repairs === undefined
        ? {}
        : {
            maxStructuredOutputRepairs: numericValue(
              'maxStructuredOutputRepairs',
              repairs,
            ),
          }),
      ...baseUrl(values),
    });
  },
  catalog: (input, transport) => readCatalog(input, transport),
};
