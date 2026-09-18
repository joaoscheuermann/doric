import { z } from 'zod';

import { ProviderErrorObject } from '../classes/provider-error.js';
import type {
  JsonObject,
  JsonValue,
  ProviderFinished,
  ProviderId,
  ProviderMessage,
  ProviderRequest,
  ProviderStructuredFinished,
  StructuredOutputSchema,
} from '../types/provider.js';
import { diagnosticExcerpt } from '../utils/diagnostics.js';
import { asRecord } from '../utils/json.js';

/** Converts a supported structured-output schema to a JSON Schema object. */
export const structuredJsonSchema = (
  provider: ProviderId,
  schema: StructuredOutputSchema | undefined,
): JsonObject | undefined => {
  if (schema === undefined) {
    return undefined;
  }

  if (!(schema instanceof z.ZodType)) {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_structured_schema',
      message: `${provider} structured output schema must be a Zod schema.`,
    });
  }

  let value: unknown;

  try {
    value = z.toJSONSchema(schema, {
      io: 'output',
      unrepresentable: 'throw',
    });
  } catch (cause) {
    throw new ProviderErrorObject(
      {
        provider,
        code: 'invalid_structured_schema',
        message: `${provider} structured output schema cannot be represented as JSON Schema.`,
      },
      { cause },
    );
  }

  const json = asJsonObject(value);

  if (json?.type !== 'object') {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_structured_schema',
      message: `${provider} structured output schema must produce an object JSON Schema.`,
    });
  }

  return json;
};

export const messagesWithStructuredSchema = (
  provider: ProviderId,
  request: ProviderRequest<unknown>,
  convertedSchema?: JsonObject,
): readonly ProviderMessage[] => {
  if (
    request.flags?.includeStructuredSchemaOnSystemPrompt !== true ||
    request.schema === undefined
  ) {
    return request.messages;
  }

  const schema =
    convertedSchema ?? structuredJsonSchema(provider, request.schema);

  if (schema === undefined) {
    return request.messages;
  }

  const content = structuredSchemaPrompt(schema);
  const system = request.messages.filter(
    (message) => message.role === 'system',
  );
  const nonSystem = request.messages.filter(
    (message) => message.role !== 'system',
  );

  return [...system, { role: 'system', content }, ...nonSystem];
};

/** Returns whether a JSON Schema meets the strict object rules used by APIs. */
export const isStrictCompatible = (value: JsonValue): boolean => {
  if (Array.isArray(value)) {
    return value.every(isStrictCompatible);
  }

  const record = asRecord(value);

  if (record === undefined) {
    return true;
  }

  const childrenAreStrict = Object.values(record).every((child) =>
    isStrictCompatible(child as JsonValue),
  );
  const properties = asRecord(record.properties);

  if (record.type !== 'object' || properties === undefined) {
    return childrenAreStrict;
  }

  const required = Array.isArray(record.required) ? record.required : [];

  return (
    record.additionalProperties === false &&
    Object.keys(properties).every((key) => required.includes(key)) &&
    childrenAreStrict
  );
};

const structuredSchemaPrompt = (schema: JsonObject): string => {
  const json = JSON.stringify(schema, null, 2);
  const fence = commonMarkFence(json);

  return `Return exactly one JSON object that matches the JSON Schema below. Output just the JSON object string, DO NOT include any Markdown fences or any text outside the JSON object.
${fence}json
${json}
${fence}`;
};

const commonMarkFence = (value: string): string => {
  const backticks = longestRun(value, /`+/g);
  const tildes = longestRun(value, /~+/g);
  const marker = backticks <= tildes ? '`' : '~';
  const longest = marker === '`' ? backticks : tildes;

  return marker.repeat(Math.max(3, longest + 1));
};

const longestRun = (value: string, pattern: RegExp): number =>
  Math.max(0, ...[...value.matchAll(pattern)].map(([run]) => run.length));

export const parseStructuredOutput = <Output = JsonValue>(
  provider: ProviderId,
  request: ProviderRequest<Output>,
  finish: ProviderFinished<unknown>,
  rejectNonStructured = true,
): ProviderFinished<Output> => {
  const schema = request.schema;

  if (schema === undefined) {
    return finish as ProviderFinished<Output>;
  }

  if (!rejectNonStructured) {
    return finish as ProviderFinished<Output>;
  }

  if (finish.refusal !== undefined || finish.toolCalls.length > 0) {
    throw new ProviderErrorObject({
      provider,
      code: 'invalid_structured_output',
      message: `${provider} returned a refusal or tool call instead of structured output.`,
    });
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(finish.text) as unknown;
  } catch (cause) {
    const data = {
      provider,
      code: 'invalid_structured_output',
      message: `${provider} returned invalid structured output.`,
      diagnostic: structuredOutputDiagnostic(finish),
    };
    throw new ProviderErrorObject(data, { cause });
  }

  const structured: ProviderStructuredFinished<Output> = {
    ...finish,
    structured: validateStructuredOutput(provider, schema, parsed) as Output,
  };

  return structured;
};

const structuredOutputDiagnostic = (
  finish: ProviderFinished<unknown>,
): string => {
  if (finish.text.trim() !== '') {
    return diagnosticExcerpt(finish.text);
  }

  return [
    'response text was empty',
    `finishReason=${finish.finishReason}`,
    ...(finish.usage?.outputTokens === undefined
      ? []
      : [`outputTokens=${finish.usage.outputTokens}`]),
    ...(finish.usage?.reasoningTokens === undefined
      ? []
      : [`reasoningTokens=${finish.usage.reasoningTokens}`]),
  ].join('; ');
};

const validateStructuredOutput = <Schema extends StructuredOutputSchema>(
  provider: ProviderId,
  schema: Schema,
  value: unknown,
): z.output<Schema> => {
  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new ProviderErrorObject({
    provider,
    code: 'invalid_structured_output',
    message: `${provider} structured output failed schema validation.`,
    diagnostic: parsed.error.issues.map(issueDiagnostic).join('; '),
  });
};

const issueDiagnostic = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.map(String).join('.');

  return path === '' ? issue.message : `${path}: ${issue.message}`;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return Number.isFinite(value) || typeof value !== 'number';
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
};

const asJsonObject = (value: unknown): JsonObject | undefined =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  isJsonValue(value)
    ? (value as JsonObject)
    : undefined;
