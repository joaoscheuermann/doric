import { ContractError } from 'bundle/contracts';

/**
 * A stream ID is `<owner>.<family>/<key>`: a qualified family name whose
 * first segment is the owning bundle, a slash, and a key without whitespace.
 */
export const streamIdPattern = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+\/[^\s]+$/;

export interface StreamId {
  /** The first segment: the bundle that owns the stream. */
  readonly owner: string;
  /** The qualified family name before the slash, owner included. */
  readonly family: string;
  /** Everything after the first slash. */
  readonly key: string;
}

/** Splits a stream ID; one that breaks the pattern is `invalid_stream`. */
export const parseStreamId = (id: string): StreamId => {
  if (!streamIdPattern.test(id)) {
    throw new ContractError(
      'invalid_stream',
      `"${id}" is not a stream ID of the form <owner>.<family>/<key>.`,
      { stream: id },
    );
  }

  const slash = id.indexOf('/');
  const family = id.slice(0, slash);

  return {
    owner: family.slice(0, family.indexOf('.')),
    family,
    key: id.slice(slash + 1),
  };
};
