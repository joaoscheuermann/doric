// The readings' shared helpers (openui-diagrams-phase2.md F14): elements, strings,
// lists of parts, code-point lengths, quoting, label cuts, id uniqueness, and the
// finding for a part in the wrong nested list.

import { DIAGRAM_PARTS, TEXT_LIMITS } from './definitions.js';

/** An element's props, or any record. */
export type Props = Readonly<Record<string, unknown>>;

/** An OpenUI element as the parser returns it. */
export interface Element {
  readonly type: 'element';
  readonly typeName: string;
  readonly statementId?: string;
  readonly props: Props;
}

/**
 * True when `value` is an object with `type === 'element'`, a string
 * `typeName` and a non-null object `props`. Never throws.
 */
export const isElement = (value: unknown): value is Element =>
  typeof value === 'object' &&
  value !== null &&
  (value as { type?: unknown }).type === 'element' &&
  typeof (value as { typeName?: unknown }).typeName === 'string' &&
  typeof (value as { props?: unknown }).props === 'object' &&
  (value as { props?: unknown }).props !== null;

/** A non-null object (arrays included). */
export const isRecord = (value: unknown): value is Props =>
  typeof value === 'object' && value !== null;

/** The value when it is a string. */
export const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The props of each entry of `list` that is a `typeName` element whose
 * `required` props are all strings, in list order. `[]` when `list` is not an
 * array. Other entries are skipped without a finding.
 */
export const partsOf = (
  list: unknown,
  typeName: string,
  required: readonly string[],
): readonly Props[] =>
  (Array.isArray(list) ? list : []).flatMap((entry: unknown) =>
    isRecord(entry) &&
    entry.type === 'element' &&
    entry.typeName === typeName &&
    isRecord(entry.props) &&
    required.every((key) => typeof (entry.props as Props)[key] === 'string')
      ? [entry.props]
      : [],
  );

/** Code points. */
export const length = (value: string): number => [...value].length;

/** A text as a finding writes it: shortened past 24 characters, then JSON-escaped. */
export const quote = (text: string): string =>
  JSON.stringify(
    length(text) > 24 ? `${[...text].slice(0, 23).join('')}…` : text,
  );

/** A label cut at `TEXT_LIMITS.label` code points, with `…` as its last character. */
export const cutLabel = (label: string): string =>
  length(label) > TEXT_LIMITS.label
    ? `${[...label].slice(0, TEXT_LIMITS.label - 1).join('')}…`
    : label;

/**
 * The parts with a valid, unrepeated id, in order, the first `limit` of them
 * in `kept`; `before` is the number of such parts, set only when it exceeds
 * `limit`. Appends the findings to `findings` in part order, the limit
 * finding last; mutates nothing else. Never throws.
 */
export const keepUnique = (
  diagram: string,
  type: string,
  plural: string,
  parts: readonly Props[],
  limit: number,
  findings: string[],
): { readonly kept: readonly Props[]; readonly before?: number } => {
  const seen = new Set<string>();
  const valid: Props[] = [];
  for (const part of parts) {
    const id = part.id as string;
    if (length(id) < 1 || length(id) > TEXT_LIMITS.id) {
      findings.push(
        `${type} ${quote(id)} is not drawn because an id has 1 to ${TEXT_LIMITS.id} characters.`,
      );
    } else if (seen.has(id)) {
      findings.push(
        `${type} ${quote(id)} appears twice, and only the first is drawn.`,
      );
    } else {
      seen.add(id);
      valid.push(part);
    }
  }
  if (valid.length <= limit) return { kept: valid };
  findings.push(
    `The ${diagram} has ${valid.length} ${plural}, and only the first ${limit} are drawn: split the diagram.`,
  );
  return { kept: valid.slice(0, limit), before: valid.length };
};

/**
 * Each element of `list` whose `typeName` is one of `DIAGRAM_PARTS.SequenceDiagram` but not in
 * `allowed` gives `A <Type> in <prop> is not drawn: <prop> holds <allowed>.`, `<allowed>` joined
 * with ", " and a final " and ". Appends one finding per such entry, in list order; does
 * nothing when `list` is not an array. Never throws.
 */
export const misplaced = (
  list: unknown,
  prop: 'steps' | 'sections',
  allowed: readonly string[],
  findings: string[],
): void => {
  if (!Array.isArray(list)) return;
  const names =
    allowed.length > 1
      ? `${allowed.slice(0, -1).join(', ')} and ${allowed.at(-1)}`
      : allowed.join('');
  for (const entry of list) {
    if (
      isElement(entry) &&
      DIAGRAM_PARTS.SequenceDiagram.includes(entry.typeName) &&
      !allowed.includes(entry.typeName)
    ) {
      findings.push(
        `A ${entry.typeName} in ${prop} is not drawn: ${prop} holds ${names}.`,
      );
    }
  }
};
