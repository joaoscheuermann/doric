/**
 * Restricted semver: versions `MAJOR.MINOR.PATCH[-prerelease]` (no build
 * metadata), ranges made of `*`, exact versions, `^`, `~` and the comparators
 * `=`, `>`, `>=`, `<`, `<=`, joined by spaces (and) and `||` (or).
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

const numeric = '0|[1-9][0-9]*';
const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionSource = `(${numeric})\\.(${numeric})\\.(${numeric})(?:-(${identifier}(?:\\.${identifier})*))?`;
const versionPattern = new RegExp(`^${versionSource}$`);

export const parseVersion = (value: string): SemVer | undefined => {
  const match = versionPattern.exec(value);

  if (match === null) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease:
      match[4] === undefined
        ? []
        : match[4]
            .split('.')
            .map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part)),
  };
};

export const isVersion = (value: string): boolean =>
  parseVersion(value) !== undefined;

const compareIdentifiers = (
  left: string | number,
  right: string | number,
): number => {
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.sign(left - right);
  }

  if (typeof left === 'number') {
    return -1;
  }

  if (typeof right === 'number') {
    return 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
};

export const compareVersions = (left: SemVer, right: SemVer): number => {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) {
      return Math.sign(left[key] - right[key]);
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }

  // A release ranks above any of its prereleases.
  if (left.prerelease.length === 0) {
    return 1;
  }

  if (right.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(left.prerelease.length, right.prerelease.length);

  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];

    if (a === undefined) {
      return -1;
    }

    if (b === undefined) {
      return 1;
    }

    const order = compareIdentifiers(a, b);

    if (order !== 0) {
      return order;
    }
  }

  return 0;
};

/** Compares two version strings; throws when either is invalid. */
export const compare = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);

  if (a === undefined || b === undefined) {
    throw new TypeError(`Invalid version "${a === undefined ? left : right}".`);
  }

  return compareVersions(a, b);
};

type Operator = '=' | '>' | '>=' | '<' | '<=';

interface Comparator {
  readonly operator: Operator;
  readonly version: SemVer;
}

const version = (major: number, minor: number, patch: number): SemVer => ({
  major,
  minor,
  patch,
  prerelease: [],
});

/** The lowest version of a release line, so `<` excludes its prereleases too. */
const floor = (major: number, minor: number, patch: number): SemVer => ({
  major,
  minor,
  patch,
  prerelease: [0],
});

const comparatorPattern = new RegExp(`^(\\^|~|>=|<=|>|<|=)?${versionSource}$`);

const expand = (token: string): readonly Comparator[] | undefined => {
  if (token === '*' || token === 'x' || token === 'X') {
    return [];
  }

  const match = comparatorPattern.exec(token);

  if (match === null) {
    return undefined;
  }

  const parsed = parseVersion(token.slice(match[1]?.length ?? 0));

  if (parsed === undefined) {
    return undefined;
  }

  const { major, minor, patch } = parsed;

  switch (match[1]) {
    case '^': {
      const upper =
        major > 0
          ? floor(major + 1, 0, 0)
          : minor > 0
            ? floor(0, minor + 1, 0)
            : floor(0, 0, patch + 1);

      return [
        { operator: '>=', version: parsed },
        { operator: '<', version: upper },
      ];
    }
    case '~':
      return [
        { operator: '>=', version: parsed },
        { operator: '<', version: floor(major, minor + 1, 0) },
      ];
    case undefined:
    case '=':
      return [{ operator: '=', version: parsed }];
    default:
      return [{ operator: match[1] as Operator, version: parsed }];
  }
};

type ComparatorSet = readonly Comparator[];

const parseRangeSets = (
  range: string,
): readonly ComparatorSet[] | undefined => {
  const sets: ComparatorSet[] = [];

  for (const alternative of range.split('||')) {
    const tokens = alternative.trim().split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      return undefined;
    }

    const set: Comparator[] = [];

    for (const token of tokens) {
      const comparators = expand(token);

      if (comparators === undefined) {
        return undefined;
      }

      set.push(...comparators);
    }

    sets.push(set);
  }

  return sets;
};

export const isRange = (range: string): boolean =>
  parseRangeSets(range) !== undefined;

const test = (comparator: Comparator, candidate: SemVer): boolean => {
  const order = compareVersions(candidate, comparator.version);

  switch (comparator.operator) {
    case '=':
      return order === 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
  }
};

const sameRelease = (left: SemVer, right: SemVer) =>
  left.major === right.major &&
  left.minor === right.minor &&
  left.patch === right.patch;

/**
 * Whether a version satisfies a range. A prerelease satisfies a set only when
 * the set names a prerelease of the same release (npm semantics); the implicit
 * upper bounds of `^`/`~` never count as naming one.
 */
export const satisfies = (candidate: string, range: string): boolean => {
  const parsed = parseVersion(candidate);
  const sets = parseRangeSets(range);

  if (parsed === undefined || sets === undefined) {
    return false;
  }

  return sets.some((set) => {
    if (!set.every((comparator) => test(comparator, parsed))) {
      return false;
    }

    if (parsed.prerelease.length === 0) {
      return true;
    }

    return set.some(
      (comparator) =>
        comparator.version.prerelease.length > 0 &&
        !(
          comparator.operator === '<' &&
          comparator.version.prerelease.length === 1 &&
          comparator.version.prerelease[0] === 0
        ) &&
        sameRelease(comparator.version, parsed),
    );
  });
};

/**
 * The single major a range admits, or undefined when it admits none or
 * several (`>=1.0.0`, `*`, `^1.0.0 || ^2.0.0`).
 */
export const rangeMajor = (range: string): number | undefined => {
  const sets = parseRangeSets(range);

  if (sets === undefined) {
    return undefined;
  }

  const majors = new Set<number>();

  for (const set of sets) {
    let lower: SemVer | undefined;
    let upper: { version: SemVer; inclusive: boolean } | undefined;

    for (const { operator, version: bound } of set) {
      if (operator === '=' || operator === '>=' || operator === '>') {
        if (lower === undefined || compareVersions(bound, lower) > 0) {
          lower = bound;
        }
      }

      if (operator === '=' || operator === '<=' || operator === '<') {
        if (upper === undefined || compareVersions(bound, upper.version) < 0) {
          upper = { version: bound, inclusive: operator !== '<' };
        }
      }
    }

    if (lower === undefined || upper === undefined) {
      return undefined;
    }

    const major = lower.major;
    const limit = upper.version;
    const withinMajor =
      limit.major === major ||
      (limit.major === major + 1 &&
        !upper.inclusive &&
        compareVersions(limit, version(major + 1, 0, 0)) <= 0);

    if (!withinMajor) {
      return undefined;
    }

    majors.add(major);
  }

  return majors.size === 1 ? [...majors][0] : undefined;
};

export const formatVersion = (value: SemVer): string =>
  `${value.major}.${value.minor}.${value.patch}${
    value.prerelease.length > 0 ? `-${value.prerelease.join('.')}` : ''
  }`;

export type ChangeLevel = 'none' | 'patch' | 'minor' | 'major';

/** The smallest version a release with this change level must reach. */
export const bump = (base: string, level: ChangeLevel): string => {
  const parsed = parseVersion(base);

  if (parsed === undefined) {
    throw new TypeError(`Invalid version "${base}".`);
  }

  switch (level) {
    case 'none':
      return formatVersion(parsed);
    case 'patch':
      return formatVersion(
        version(parsed.major, parsed.minor, parsed.patch + 1),
      );
    case 'minor':
      return formatVersion(version(parsed.major, parsed.minor + 1, 0));
    case 'major':
      return formatVersion(version(parsed.major + 1, 0, 0));
  }
};
