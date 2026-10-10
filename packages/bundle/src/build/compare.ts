import { z } from 'zod';

import type { JsonObject } from '../contracts/types.js';
import {
  type Descriptor,
  descriptorEntrySchema,
} from '../runtime/descriptor.js';
import { jsonEqual } from '../runtime/json-schema.js';
import { semverString } from '../runtime/manifest.js';
import { bump, type ChangeLevel, compare } from '../runtime/semver.js';

/** `contracts.published.json`: the last published descriptor with inlined schemas. */
export const baselineSchema = z
  .object({
    descriptorVersion: z.literal(1),
    bundle: z.object({ id: z.string(), version: semverString }).strict(),
    contracts: z.array(
      descriptorEntrySchema.extend({
        schema: z.record(z.string(), z.unknown()),
      }),
    ),
  })
  .strict();

export type Baseline = z.output<typeof baselineSchema>;

const rank: Record<ChangeLevel, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
};

const max = (left: ChangeLevel, right: ChangeLevel): ChangeLevel =>
  rank[left] >= rank[right] ? left : right;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredOf = (schema: Json): Set<string> =>
  new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

/**
 * Change level of one member schema. Inputs may gain optional properties
 * (minor); outputs may gain any property (minor); anything else that differs
 * is major. Property, array item and tuple element schemas are compared
 * recursively with the same rule.
 */
export const memberChange = (
  before: unknown,
  after: unknown,
  direction: 'input' | 'output',
): ChangeLevel => {
  if (jsonEqual(before, after)) {
    return 'none';
  }

  if (!isObject(before) || !isObject(after)) {
    return 'major';
  }

  // Arrays and tuples (method inputs are argument tuples): the same rule per
  // element schema, when everything else is unchanged.
  if (isObject(before.items) && isObject(after.items)) {
    const { items: beforeItems, ...beforeRest } = before;
    const { items: afterItems, ...afterRest } = after;

    return jsonEqual(beforeRest, afterRest)
      ? memberChange(beforeItems, afterItems, direction)
      : 'major';
  }

  if (Array.isArray(before.prefixItems) && Array.isArray(after.prefixItems)) {
    const { prefixItems: beforeItems, ...beforeRest } = before;
    const { prefixItems: afterItems, ...afterRest } = after;

    if (
      !jsonEqual(beforeRest, afterRest) ||
      beforeItems.length !== afterItems.length
    ) {
      return 'major';
    }

    let level: ChangeLevel = 'none';

    for (const [index, item] of beforeItems.entries()) {
      level = max(level, memberChange(item, afterItems[index], direction));
    }

    return level;
  }

  const beforeProperties = isObject(before.properties)
    ? before.properties
    : undefined;
  const afterProperties = isObject(after.properties)
    ? after.properties
    : undefined;

  if (beforeProperties === undefined || afterProperties === undefined) {
    return 'major';
  }

  const { properties: _p1, required: _r1, ...beforeRest } = before;
  const { properties: _p2, required: _r2, ...afterRest } = after;

  if (!jsonEqual(beforeRest, afterRest)) {
    return 'major';
  }

  const beforeRequired = requiredOf(before);
  const afterRequired = requiredOf(after);
  let level: ChangeLevel = 'none';

  for (const [key, schema] of Object.entries(beforeProperties)) {
    if (!(key in afterProperties)) {
      return 'major';
    }

    if (beforeRequired.has(key) !== afterRequired.has(key)) {
      // Required ↔ optional changes what one side may rely on.
      return 'major';
    }

    level = max(level, memberChange(schema, afterProperties[key], direction));

    if (level === 'major') {
      return level;
    }
  }

  for (const key of Object.keys(afterProperties)) {
    if (key in beforeProperties) {
      continue;
    }

    if (direction === 'input' && afterRequired.has(key)) {
      return 'major';
    }

    level = max(level, 'minor');
  }

  return level;
};

const directionOf = (member: string): 'input' | 'output' =>
  member.endsWith('.output') ? 'output' : 'input';

/** Change level between two contract documents. */
export const documentChange = (
  before: JsonObject,
  after: JsonObject,
): ChangeLevel => {
  if (jsonEqual(before, after)) {
    return 'none';
  }

  const { $defs: beforeDefs, ...beforeRest } = before as Json;
  const { $defs: afterDefs, ...afterRest } = after as Json;

  if (
    !jsonEqual(beforeRest, afterRest) ||
    !isObject(beforeDefs) ||
    !isObject(afterDefs)
  ) {
    return 'major';
  }

  let level: ChangeLevel = 'none';

  for (const [member, schema] of Object.entries(beforeDefs)) {
    if (!(member in afterDefs)) {
      return 'major';
    }

    level = max(
      level,
      memberChange(schema, afterDefs[member], directionOf(member)),
    );
  }

  for (const member of Object.keys(afterDefs)) {
    if (!(member in beforeDefs)) {
      level = max(level, 'minor');
    }
  }

  return level;
};

export interface CompareInput {
  readonly descriptor: Descriptor;
  /** Contract documents by contract ID. */
  readonly documents: ReadonlyMap<string, JsonObject>;
  readonly baseline: Baseline;
}

export interface CompareResult {
  readonly errors: readonly string[];
  /** Change level per contract ID. */
  readonly changes: ReadonlyMap<string, ChangeLevel>;
  readonly bundleChange: ChangeLevel;
}

const shape = (
  entries: readonly {
    kind: string;
    cardinality: string;
    environment: string;
  }[],
) =>
  entries
    .map(
      ({ kind, cardinality, environment }) =>
        `${kind}/${cardinality}/${environment}`,
    )
    .sort()
    .join(',');

/** The build-time semver check of a bundle against its published baseline. */
export const compareWithBaseline = (input: CompareInput): CompareResult => {
  const { descriptor, documents, baseline } = input;
  const errors: string[] = [];
  const changes = new Map<string, ChangeLevel>();
  let bundleChange: ChangeLevel = 'none';
  const group = <T extends { id: string }>(entries: readonly T[]) => {
    const byId = new Map<string, T[]>();

    for (const entry of entries) {
      byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
    }

    return byId;
  };
  const current = group(descriptor.contracts);
  const published = group(baseline.contracts);

  for (const [id, before] of published) {
    const after = current.get(id);

    if (after === undefined) {
      changes.set(id, 'major');
      bundleChange = 'major';
      continue;
    }

    const document = documents.get(id);
    const level =
      shape(before) !== shape(after) || document === undefined
        ? 'major'
        : documentChange(
            (before[0] as Baseline['contracts'][number]).schema as JsonObject,
            document,
          );

    changes.set(id, level);

    const baseVersion = (before[0] as { version: string }).version;
    const version = (after[0] as { version: string }).version;

    if (level === 'major') {
      errors.push(
        `${id}: incompatible change (major: new /v${Number(id.split('/v').at(-1)) + 1}).`,
      );
      continue;
    }

    const minimum = bump(baseVersion, level);

    if (compare(version, minimum) < 0) {
      errors.push(
        `${id}: version ${version} is lower than the change requires (${minimum}; published ${baseVersion}).`,
      );
    }

    bundleChange = max(bundleChange, level);
  }

  for (const id of current.keys()) {
    if (!published.has(id)) {
      changes.set(id, 'minor');
      bundleChange = max(bundleChange, 'minor');
    }
  }

  const minimumBundle = bump(baseline.bundle.version, bundleChange);

  if (compare(descriptor.bundle.version, minimumBundle) < 0) {
    errors.push(
      `bundle ${descriptor.bundle.id}: version ${descriptor.bundle.version} is lower than its contract changes require (${minimumBundle}; published ${baseline.bundle.version}).`,
    );
  }

  return { errors, changes, bundleChange };
};
