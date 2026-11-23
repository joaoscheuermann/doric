// Today's JSON ⇄ the generated messages of runtime's protos (phase 3, slice
// S46a): one generic codec plus per-oneof mappings for the discriminated
// oneofs whose domain encodings differ per case.

import {
  type DescField,
  type DescMessage,
  type DescOneof,
  fromJson,
  getOption,
  hasOption,
  type JsonObject,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import { oneof as validateOneof } from 'bundle/contracts/gen/buf/validate/validate_pb.js';
import { oneof as platformOneof } from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

/** Where one case's payload sits in today's JSON. */
export type OneofPayload =
  /** The case message's fields sit beside the discriminator (`{kind:'terminal', terminalId}`). */
  | 'spread'
  /** The case value sits under this key (`{kind:'threadUpdated', value}`, `{kind:'updated', thread}`). */
  | { readonly key: string };

/** One case of a discriminated oneof: today's discriminator value and payload position. */
export interface OneofCase {
  readonly value: string;
  readonly payload: OneofPayload;
}

/**
 * How one oneof with `(doric.platform.v1.oneof).discriminator` maps to today's
 * JSON. `message` is the holding message's `typeName`. `cases` is keyed by
 * each case field's JSON name. A discriminated oneof without a mapping uses
 * the default: every case has `value` = the field's JSON name and payload
 * `'spread'` (right for `InputSource`).
 */
export interface OneofMapping {
  readonly message: string;
  readonly cases: Readonly<Record<string, OneofCase>>;
}

/**
 * The mappings runtime's services use: `WatchResponse`,
 * `WatchProjectResponse`, `WatchThreadResponse`.
 */
export const runtimeOneofs: readonly OneofMapping[] = [
  {
    message: 'doric.runtime.v2.WatchResponse',
    cases: {
      event: { value: 'event', payload: { key: 'value' } },
      threadUpdated: { value: 'threadUpdated', payload: { key: 'value' } },
      projectUpdated: { value: 'projectUpdated', payload: { key: 'value' } },
      terminalUpdated: { value: 'terminalUpdated', payload: { key: 'value' } },
      terminalOutput: { value: 'terminalOutput', payload: { key: 'value' } },
    },
  },
  {
    message: 'doric.runtime.v2.WatchProjectResponse',
    cases: {
      projectUpdated: { value: 'project-updated', payload: { key: 'project' } },
      projectDeleted: { value: 'project-deleted', payload: 'spread' },
      threadUpdated: { value: 'thread-updated', payload: { key: 'thread' } },
      threadDeleted: { value: 'thread-deleted', payload: 'spread' },
    },
  },
  {
    message: 'doric.runtime.threads.v1.WatchThreadResponse',
    cases: {
      event: { value: 'event', payload: { key: 'event' } },
      updated: { value: 'updated', payload: { key: 'thread' } },
    },
  },
];

const invalidOutput = (message: string): ContractError =>
  new ContractError('invalid_output', message);

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A discriminated oneof of `desc`, with each case's mapping. */
interface Discriminated {
  readonly oneof: DescOneof;
  readonly discriminator: string;
  readonly cases: readonly (OneofCase & { readonly field: DescField })[];
}

const discriminatedOneofs = (
  desc: DescMessage,
  mappings: readonly OneofMapping[],
): readonly Discriminated[] => {
  const mapping = mappings.find(({ message }) => message === desc.typeName);
  return desc.oneofs
    .filter((oneof) => hasOption(oneof, platformOneof))
    .map((oneof) => ({
      oneof,
      discriminator: getOption(oneof, platformOneof).discriminator,
      cases: oneof.fields.map((field) => ({
        field,
        ...(mapping?.cases[field.jsonName] ?? {
          value: field.jsonName,
          payload: 'spread' as const,
        }),
      })),
    }));
};

/** The message a field holds, unless it is a well-known type read as-is. */
const nestedMessage = (field: DescField): DescMessage | undefined =>
  (field.fieldKind === 'message' ||
    (field.fieldKind === 'list' && field.listKind === 'message') ||
    (field.fieldKind === 'map' && field.mapKind === 'message')) &&
  field.message !== undefined &&
  !field.message.typeName.startsWith('google.protobuf.')
    ? field.message
    : undefined;

/** Applies `convert` to a field's nested message value(s). */
const nested = (
  field: DescField,
  value: JsonValue,
  convert: (desc: DescMessage, value: JsonValue) => JsonValue,
): JsonValue => {
  const desc = nestedMessage(field);
  if (desc === undefined) return value;
  if (field.fieldKind === 'list')
    return Array.isArray(value) ? value.map((item) => convert(desc, item)) : value;
  if (field.fieldKind === 'map')
    return isObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, convert(desc, item)]),
        )
      : value;
  return convert(desc, value);
};

const fieldOf = (desc: DescMessage, key: string): DescField | undefined =>
  desc.fields.find(({ jsonName, name }) => jsonName === key || name === key);

/** Today's JSON as the proto JSON of `desc`. */
const toProtoJson = (
  desc: DescMessage,
  value: JsonValue,
  mappings: readonly OneofMapping[],
): JsonValue => {
  if (!isObject(value)) return value;
  const rest: JsonObject = { ...value };
  const out: JsonObject = {};
  for (const { oneof, discriminator, cases } of discriminatedOneofs(
    desc,
    mappings,
  )) {
    if (!Object.hasOwn(rest, discriminator)) {
      if (
        hasOption(oneof, validateOneof) &&
        getOption(oneof, validateOneof).required &&
        !oneof.fields.some((field) => fieldOf(desc, field.jsonName) && Object.hasOwn(rest, field.jsonName))
      )
        throw invalidOutput(
          `${desc.typeName}: the discriminator "${discriminator}" is missing.`,
        );
      continue;
    }
    const kind = rest[discriminator];
    delete rest[discriminator];
    const match = cases.find((item) => item.value === kind);
    if (match === undefined)
      throw invalidOutput(
        `${desc.typeName}: "${String(kind)}" is not a known ${discriminator}.`,
      );
    let payload: JsonValue | undefined;
    if (match.payload === 'spread') {
      const spread: JsonObject = {};
      for (const [key, item] of Object.entries(rest)) {
        const field = fieldOf(desc, key);
        if (field !== undefined && field.oneof !== oneof) continue;
        spread[key] = item;
        delete rest[key];
      }
      payload = spread;
    } else {
      payload = rest[match.payload.key];
      delete rest[match.payload.key];
    }
    if (payload !== undefined && payload !== null)
      out[match.field.jsonName] = nested(match.field, payload, (d, v) =>
        toProtoJson(d, v, mappings),
      );
  }
  for (const [key, item] of Object.entries(rest)) {
    const field = fieldOf(desc, key);
    if (field === undefined) continue;
    out[key] = nested(field, item, (d, v) => toProtoJson(d, v, mappings));
  }
  return out;
};

/** The proto JSON of `desc` as today's JSON. */
const fromProtoJson = (
  desc: DescMessage,
  value: JsonValue,
  mappings: readonly OneofMapping[],
): JsonValue => {
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const field = fieldOf(desc, key);
    out[key] =
      field === undefined
        ? item
        : nested(field, item, (d, v) => fromProtoJson(d, v, mappings));
  }
  for (const { discriminator, cases } of discriminatedOneofs(desc, mappings)) {
    const match = cases.find(({ field }) => Object.hasOwn(out, field.jsonName));
    if (match === undefined) continue;
    const payload = out[match.field.jsonName] as JsonValue;
    delete out[match.field.jsonName];
    out[discriminator] = match.value;
    if (match.payload === 'spread') {
      if (isObject(payload)) Object.assign(out, payload);
    } else out[match.payload.key] = payload;
  }
  return out;
};

/**
 * Today's JSON `value` as a message of `schema`. `value` is first made JSON
 * (`JSON.stringify` semantics: `undefined` dropped, `Date` as ISO), then each
 * discriminated oneof at any depth is rewritten from `{<discriminator>: v, …}`
 * to `{<case>: payload}` by `mappings`, then read with `fromJson(…,
 * {ignoreUnknownFields: true})`.
 *
 * Kept: every field the message declares (an unknown key of a loose object is
 * dropped); `null` leaves a field unset.
 *
 * Throws `ContractError('invalid_output')` when `value` does not fit
 * `schema`: wrong type, unknown discriminator value, or a missing
 * discriminator on a required oneof. Responses call it, so a domain answer
 * the proto cannot carry is the provider's fault.
 */
export const encode = <D extends DescMessage>(
  schema: D,
  value: unknown,
  mappings: readonly OneofMapping[] = [],
): MessageShape<D> => {
  const text = JSON.stringify(value);
  if (text === undefined)
    throw invalidOutput(`${schema.typeName}: the answer is not JSON.`);
  const json = toProtoJson(schema, JSON.parse(text) as JsonValue, mappings);
  try {
    return fromJson(schema, json, { ignoreUnknownFields: true });
  } catch (error) {
    throw invalidOutput(
      `${schema.typeName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * A message of `schema` as today's JSON: `toJson(…, {alwaysEmitImplicit:
 * true})`, so implicit fields are present (`""`, `0`, `[]`) and optional ones
 * absent. Then each discriminated oneof is flattened back by `mappings` (the
 * inverse of {@link encode}). Never throws for a message of `schema`.
 * Requests and routed answers call it before today's zod schema parses the
 * result.
 */
export const decode = <D extends DescMessage>(
  schema: D,
  message: MessageShape<D>,
  mappings: readonly OneofMapping[] = [],
): JsonValue =>
  fromProtoJson(
    schema,
    toJson(schema, message, { alwaysEmitImplicit: true }),
    mappings,
  );
