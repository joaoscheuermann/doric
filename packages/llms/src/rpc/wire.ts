// The llms ↔ `models.provider/v1` value converters both sides of the
// routed provider share: `serveProviderKind` (./index.ts) and
// `modelsLanguageModel` (./client.ts).

import type {
  JsonObject as WireJsonObject,
  JsonValue as WireJsonValue,
} from '@bufbuild/protobuf';
import type { ProviderToolCall as WireToolCall } from 'bundle/contracts/gen/doric/models/provider/v1/provider_pb.js';

import type { ProviderToolCall } from '../lib/types/provider.js';

/** A value as JSON carries it; what JSON cannot carry is left out. */
export const jsonOf = (value: unknown): WireJsonValue | undefined => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => jsonOf(item) ?? null);
  }

  if (typeof value === 'object') {
    return jsonObjectOf(value);
  }

  return undefined;
};

export const jsonObjectOf = (value: object): WireJsonObject => {
  const object: WireJsonObject = {};

  for (const [key, member] of Object.entries(value)) {
    const json = jsonOf(member);

    if (json !== undefined) {
      object[key] = json;
    }
  }

  return object;
};

export const toolCallOf = (call: WireToolCall): ProviderToolCall => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
  index: call.index,
});

export const wireToolCall = (call: ProviderToolCall) => ({
  id: call.id,
  name: call.name,
  arguments: call.arguments,
  index: call.index,
});
