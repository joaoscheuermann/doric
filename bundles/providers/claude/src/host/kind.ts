import { claudeMetadata, createClaudeProvider } from 'llms';

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
          'Names the stored API_TOKEN credential that carries the Claude authorization value.',
      }),
    ],
    lists: [],
  },
  advertised: true,
  catalogCapacity: false,
  build: (values, deps) =>
    createClaudeProvider({
      transport: deps.transport,
      logger: deps.logger,
      identity: deps.identity,
      authorization: values.token ?? '',
      ...baseUrl(values),
    }),
};
