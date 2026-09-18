import type { Model } from '../../types/provider.js';
import {
  arrayField,
  asRecord,
  numberField,
  recordField,
  stringField,
} from '../../utils/json.js';

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
