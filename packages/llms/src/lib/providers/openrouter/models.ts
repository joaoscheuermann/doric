import type { Model, ProviderId } from '../../types/provider.js';
import {
  arrayField,
  asRecord,
  numberField,
  recordField,
  stringField,
} from '../../utils/json.js';
import { requestJson } from '../http.js';
import type { OpenRouterProviderDeps } from '../openrouter.js';
import { authorization } from './auth.js';

export const createOpenRouterModelsLoader =
  (
    deps: Pick<OpenRouterProviderDeps, 'transport' | 'apiKey'>,
    baseUrl: string,
    providerId: ProviderId,
  ) =>
  async (signal?: AbortSignal): Promise<readonly Model[]> => {
    const response = await requestJson(deps.transport, providerId, {
      method: 'GET',
      url: `${baseUrl}/models`,
      headers: {
        authorization: await authorization(deps.apiKey),
        accept: 'application/json',
      },
      signal,
    });

    return modelsFromResponse(response);
  };

export const modelsFromResponse = (
  response: Record<string, unknown>,
): readonly Model[] =>
  arrayField(response, 'data').map(asRecord).filter(isRecord).map(model);

const model = (value: Record<string, unknown>): Model => {
  const topProvider = recordField(value, 'top_provider');
  const architecture = recordField(value, 'architecture');

  return {
    id: stringField(value, 'id') ?? '',
    name: stringField(value, 'name'),
    contextWindow:
      numberField(value, 'context_length') ??
      (topProvider === undefined
        ? undefined
        : numberField(topProvider, 'context_length')) ??
      (architecture === undefined
        ? undefined
        : numberField(architecture, 'context_length')) ??
      4096,
    provider: 'openrouter',
    raw: value,
  };
};

const isRecord = (
  value: Record<string, unknown> | undefined,
): value is Record<string, unknown> => value !== undefined;
