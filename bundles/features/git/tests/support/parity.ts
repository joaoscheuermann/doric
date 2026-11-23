// Parity of `git.commands/v1` through the router with the kernel service
// (phase 3, S55c, P1–P3): a routed answer must equal the kernel's domain
// answer as the message the codec's rules make of it (`null` fields absent,
// absent lists empty), compared as JSON with implicit fields emitted; and
// the codec's own message of that kernel answer must pass protovalidate.

import assert from 'node:assert/strict';

import {
  create,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';

/** Fixes Git's dates so twin workspaces made by one setup share commit ids. */
export const fixGitDates = (): void => {
  process.env.GIT_AUTHOR_DATE = '2026-01-01T00:00:00Z';
  process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00Z';
};

/** `value` without its `null` and `undefined` fields, at every depth. */
export const withoutNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== null && field !== undefined)
      .map(([key, field]) => [key, withoutNulls(field)]),
  );
};

/** `json` with every occurrence of `root` written `<root>`. */
const rooted = (json: JsonValue, root: string): JsonValue =>
  JSON.parse(JSON.stringify(json).replaceAll(root, '<root>')) as JsonValue;

const validator = createValidator();

export interface ParityCase<Desc extends DescMessage> {
  readonly label: string;
  /** The response message's schema. */
  readonly schema: Desc;
  /** The routed answer. */
  readonly routed: MessageShape<Desc>;
  /** The kernel's domain answer for the same workspace and state. */
  readonly kernel: unknown;
  /** The codec function for this response. */
  readonly codec: (answer: never) => MessageInitShape<Desc>;
  /** The workspace roots, normalized away (twins differ only there). */
  readonly roots?: { readonly routed: string; readonly kernel: string };
}

/** P1 (the routed answer equals the kernel's) and P3 (the codec's message is valid). */
export const assertParity = <Desc extends DescMessage>(
  c: ParityCase<Desc>,
): void => {
  const options = { alwaysEmitImplicit: true };
  const expected = toJson(
    c.schema,
    create(c.schema, withoutNulls(c.kernel) as MessageInitShape<Desc>),
    options,
  );
  const actual = toJson(c.schema, c.routed, options);

  assert.deepEqual(
    c.roots === undefined ? actual : rooted(actual, c.roots.routed),
    c.roots === undefined ? expected : rooted(expected, c.roots.kernel),
    `P1 ${c.label}`,
  );

  const encoded = create(c.schema, c.codec(c.kernel as never));
  const result = validator.validate(c.schema, encoded);
  assert.equal(
    result.kind,
    'valid',
    `P3 ${c.label}: ${JSON.stringify(result)}`,
  );
  assert.deepEqual(
    c.roots === undefined
      ? toJson(c.schema, encoded, options)
      : rooted(toJson(c.schema, encoded, options), c.roots.kernel),
    c.roots === undefined ? expected : rooted(expected, c.roots.kernel),
    `P3 ${c.label}: the codec's message`,
  );
};
