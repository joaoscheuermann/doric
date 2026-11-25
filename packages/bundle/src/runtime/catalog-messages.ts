// The `doric.catalog/v1` messages of the catalog values the desktop reads:
// the snapshot `Get` and `Watch` answer, and the distribution `Distribution`
// answers. The platform (which serves them) and Electron main (which reads
// them) convert with this one code.

import {
  create,
  type DescMessage,
  type JsonObject,
  type JsonValue,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import type { z } from 'zod';

import { ContractError } from '../contracts/error.js';
import {
  type CatalogSnapshot as CatalogSnapshotMessage,
  CatalogSnapshotSchema,
  type DistributionResponse,
  DistributionResponseSchema,
} from '../contracts/gen/doric/platform/catalog/v1/catalog_pb.js';
import {
  type CatalogSnapshot,
  catalogSnapshotSchema,
  type DistributionCatalog,
  distributionCatalogSchema,
} from '../contracts/platform.js';

/**
 * The `doric.catalog/v1` message of a catalog snapshot, as `Get` and
 * `Watch` answer it. Total over every `CatalogSnapshot`; never throws.
 */
export const catalogSnapshotMessage = (
  snapshot: CatalogSnapshot,
): CatalogSnapshotMessage =>
  create(CatalogSnapshotSchema, {
    generation: snapshot.generation,
    composition: {
      core: snapshot.composition.core,
      enabled: [...snapshot.composition.enabled],
      providers: { ...snapshot.composition.providers },
    },
    bundles: snapshot.bundles.map(({ manifest, reasons, ...bundle }) => ({
      ...bundle,
      ...(manifest === undefined ? {} : { manifest: jsonObjectOf(manifest) }),
      reasons: reasons.map((reason) => ({ ...reason })),
    })),
    order: [...snapshot.order],
    contracts: snapshot.contracts.map(({ providers, ...contract }) => ({
      ...contract,
      providers: providers.map((provider) => ({ ...provider })),
    })),
    ...(snapshot.storage === undefined ? {} : { storage: snapshot.storage }),
  });

/**
 * The snapshot a `CatalogSnapshot` message carries: the value whose
 * `catalogSnapshotMessage` is `message`, as `catalogSnapshotSchema` parses
 * it. Throws `ContractError('invalid_output')`, naming the field, when that
 * schema refuses it (an unknown state, a missing composition).
 */
export const catalogSnapshotOf = (
  message: CatalogSnapshotMessage,
): CatalogSnapshot =>
  parsed(
    catalogSnapshotSchema,
    jsonFormOf(CatalogSnapshotSchema, message),
    'catalog snapshot',
  );

/**
 * The `Distribution` answer of a distribution catalog: every field of
 * `catalog`, `manifest` and `descriptor` as `google.protobuf.Struct`, file
 * sizes as numbers. Total; never throws.
 */
export const distributionMessage = (
  catalog: DistributionCatalog,
): DistributionResponse =>
  create(DistributionResponseSchema, {
    generation: catalog.generation,
    hostBoot: catalog.hostBoot,
    platformVersion: catalog.platformVersion,
    composition: {
      core: catalog.composition.core,
      enabled: [...catalog.composition.enabled],
      providers: { ...catalog.composition.providers },
    },
    ...(catalog.storage === undefined ? {} : { storage: catalog.storage }),
    host: catalogSnapshotMessage(catalog.host),
    bundles: catalog.bundles.map(
      ({ manifest, descriptor, reasons, files, parts, ...bundle }) => ({
        ...bundle,
        reasons: reasons.map((reason) => ({ ...reason })),
        ...(manifest === undefined ? {} : { manifest: jsonObjectOf(manifest) }),
        ...(descriptor === undefined
          ? {}
          : { descriptor: jsonObjectOf(descriptor) }),
        files: files.map((file) => ({ ...file })),
        parts: { ...parts },
      }),
    ),
  });

/**
 * The distribution catalog a `Distribution` answer carries, as
 * `distributionCatalogSchema` parses its JSON form; so
 * `distributionCatalogOf(distributionMessage(c))` deep-equals `c` for every
 * valid `c`. Throws `ContractError('invalid_output')`, naming the field, when
 * the schema refuses it.
 */
export const distributionCatalogOf = (
  message: DistributionResponse,
): DistributionCatalog =>
  parsed(
    distributionCatalogSchema,
    jsonFormOf(DistributionResponseSchema, message),
    'distribution catalog',
  );

/**
 * `message`'s JSON form with every implicit field written (so empty lists
 * and maps are present, as the catalog schemas require them) and every unset
 * optional field left out.
 */
const jsonFormOf = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): JsonValue => toJson(schema, message, { alwaysEmitImplicit: true });

/** `json` as `schema` parses it; `invalid_output` naming each refused field. */
const parsed = <T>(schema: z.ZodType<T>, json: JsonValue, what: string): T => {
  const checked = schema.safeParse(json);

  if (!checked.success) {
    throw new ContractError(
      'invalid_output',
      `Invalid ${what} message: ${checked.error.issues
        .map(
          (issue) =>
            `${issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : ''}${issue.message}`,
        )
        .join('; ')}`,
      {
        issues: checked.error.issues.map(({ path, message }) => ({
          path: path.map(String),
          message,
        })),
      },
    );
  }

  return checked.data;
};

/**
 * `value` as JSON, as `JSON.stringify` would write it: object members whose
 * value JSON cannot hold are left out, and so become array items `null`.
 */
export const jsonOf = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => jsonOf(item));
  }

  return typeof value === 'object' ? jsonObjectOf(value) : null;
};

/** The members of `value` JSON can hold, as a JSON object. */
const jsonObjectOf = (value: object): JsonObject => {
  const json: JsonObject = {};

  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined && typeof member !== 'function') {
      json[key] = jsonOf(member);
    }
  }

  return json;
};
