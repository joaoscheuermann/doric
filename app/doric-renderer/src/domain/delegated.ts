export type DelegatedKind = 'parent' | 'result';

export type DelegatedInput = {
  readonly kind: DelegatedKind;
  readonly threadId: string;
  /** The child's terminal status, when the host recorded one. */
  readonly status?: string;
  /** The sender's own words, with the host's envelope removed when present. */
  readonly text: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The host frames a delegated result for the model, so the durable text carries
 * a header, three identifiers, the status and a `## Result` heading. Display
 * keeps only what follows that heading, and only when the header is present —
 * anything else is shown verbatim rather than guessed at.
 */
const envelope = /^# Delegated task result\n[\s\S]*?\n## [^\n]*\n/;

export const withoutEnvelope = (value: string): string => {
  const match = envelope.exec(value);
  return match === null ? value : value.slice(match[0].length).trim();
};

export const envelopeStatus = (value: string): string | undefined => {
  if (!envelope.test(value)) return undefined;
  const status = /^Status: (.+)$/m.exec(value)?.[1].trim();
  return status === undefined || status.length === 0 ? undefined : status;
};

/** Short, readable reference to a Thread: enough to compare, cheap to render. */
export const shortId = (value: string): string => value.slice(0, 8);

/**
 * How a row names the Thread that wrote it: its name when the cached tree knows
 * it, otherwise the short id in monospace — a deleted Thread must not render an
 * empty label.
 */
export const threadLabel = (
  threadId: string,
  name: string | undefined,
): { readonly value: string; readonly mono: boolean } =>
  name === undefined || name.trim().length === 0
    ? { value: shortId(threadId), mono: true }
    : { value: name, mono: false };

/**
 * The input of a turn written by another Thread, or `undefined` for the human's
 * own prompt. A `parent` instruction is already plain text; only a `result`
 * carries the host's envelope.
 */
export const delegatedInput = (
  source: unknown,
  text: string,
): DelegatedInput | undefined => {
  const kind = record(source)?.kind;
  if (kind !== 'parent' && kind !== 'result') return undefined;
  const threadId = record(source)?.threadId;
  if (typeof threadId !== 'string' || threadId.length === 0) return undefined;
  if (kind === 'parent') return { kind, threadId, text };
  const status = envelopeStatus(text);
  return {
    kind,
    threadId,
    text: withoutEnvelope(text),
    ...(status === undefined ? {} : { status }),
  };
};
