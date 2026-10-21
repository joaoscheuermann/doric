/**
 * The mark an identity carries, stated in terms of the name it is given: the
 * initials a name reads as, and the tone those initials are drawn in. The
 * conversation's blocks and the composer's stack both wear it, so the same name
 * reads the same everywhere — the one place this logic exists.
 */

/** A name split into the parts its initials are read from. */
const NAME_PARTS = /[^\p{L}\p{N}]+/u;

/** The first letter of a part, or nothing when the part is empty. */
const firstLetter = (part: string): string => [...part][0] ?? '';

/**
 * The initials a name reads as: the first letter of its first two parts,
 * uppercased — `'jao.scheuermann'` answers `'JS'` and `'Marina Costa'` `'MC'`.
 * A name with no letter or digit at all answers `'?'`, so the mark is never
 * empty.
 */
export const initials = (name: string): string => {
  const parts = name.split(NAME_PARTS).filter((part) => part.length > 0);
  const value = parts.slice(0, 2).map(firstLetter).join('').toUpperCase();
  return value.length > 0 ? value : '?';
};

/** The FNV-1a hash of a name's code points. */
const hashOf = (name: string): number => {
  let hash = 0x811c9dc5;
  for (const point of name) {
    hash ^= point.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/**
 * The tone initials are drawn in: a vivid hue derived from the name, so an
 * identity brings a colour to the surface instead of a grey wash. The lightness
 * is held where the theme's foreground still reads on it in both variants, and
 * the same name always answers the same string.
 */
export const identityTone = (name: string): string =>
  `color-mix(in oklch, oklch(0.55 0.18 ${hashOf(name) % 360}) 92%, var(--muted))`;

/**
 * The rim an identity's avatar wears: the tone itself, tamed toward the surface
 * only enough to read as an edge — the avatar's own colour, not a grey frame.
 */
export const identityRing = (name: string): string =>
  `color-mix(in oklch, ${identityTone(name)} 85%, var(--background))`;
