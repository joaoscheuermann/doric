// Program identity (openui.md D3): which program a fence writes or patches.
// Identities are per tag. A fence's identity is the info string's second word
// when it is a written identity; otherwise, and always for a question fence,
// the anonymous `_<n>`, where `n` is the fence's 1-based ordinal among the
// Thread's fences of its tag. A written identity never starts with `_`, so
// the two namespaces never meet.

/** A written identity: lowercase letter, then lowercase letters, digits and hyphens; at most 64 characters. */
export const WRITTEN_IDENTITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** An anonymous identity: `_` and a 1-based ordinal without leading zeros, at most 9 digits. */
export const ANONYMOUS_IDENTITY_PATTERN = /^_[1-9][0-9]{0,8}$/;

/** Any program identity, written or anonymous. */
export const PROGRAM_IDENTITY_PATTERN =
  /^(?:[a-z][a-z0-9-]{0,63}|_[1-9][0-9]{0,8})$/;

/**
 * The identity a fence's info string names: its second whitespace-separated
 * word when that matches `WRITTEN_IDENTITY_PATTERN`, else `undefined`. Words
 * after the second are ignored. Pure; never throws.
 */
export const writtenIdentity = (info: string): string | undefined => {
  const named = info.trim().split(/\s+/)[1];
  return named !== undefined && WRITTEN_IDENTITY_PATTERN.test(named)
    ? named
    : undefined;
};

/**
 * The anonymous identity of the fence at 1-based `ordinal` among its Thread's
 * fences of one tag: `_<ordinal>`. Throws a `RangeError` for an ordinal that
 * is not an integer from 1 to 999,999,999.
 */
export const anonymousIdentity = (ordinal: number): string => {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 999_999_999)
    throw new RangeError(`no anonymous identity for ordinal ${ordinal}`);
  return `_${ordinal}`;
};
