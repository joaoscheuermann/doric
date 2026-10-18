// Path and package-manifest helpers the component compiler shares between its
// script resolution (`compile.ts`) and its stylesheet resolution (`css.ts`).
// Every path here is a Project-relative POSIX path: the sources live in the
// Project sandbox and are read through `files/v1`, never from the host disk.

import { posix } from 'node:path';

/** Package conditions a browser module build honors, as Node orders them. */
export const SCRIPT_CONDITIONS: ReadonlySet<string> = new Set([
  'browser',
  'import',
  'module',
  'default',
]);

/** Package conditions a stylesheet import honors (Tailwind's own `style`). */
export const STYLE_CONDITIONS: ReadonlySet<string> = new Set([
  'style',
  'default',
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The package a bare specifier names: `@scope/name` or `name`. */
export const packageOf = (specifier: string): string => {
  const parts = specifier.split('/');

  return specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : (parts[0] ?? specifier);
};

export const isRelative = (specifier: string): boolean =>
  specifier === '.' ||
  specifier === '..' ||
  specifier.startsWith('./') ||
  specifier.startsWith('../') ||
  specifier.startsWith('/');

/** A Project-relative path, or `undefined` when it leaves the Project. */
export const projectPath = (
  from: string,
  specifier: string,
): string | undefined => {
  const joined = specifier.startsWith('/')
    ? posix.normalize(specifier.slice(1))
    : posix.normalize(posix.join(posix.dirname(from), specifier));

  if (joined === '..' || joined.startsWith('../') || joined === '.') {
    return undefined;
  }

  return joined.replace(/^\.\//, '');
};

const conditionTarget = (
  value: unknown,
  conditions: ReadonlySet<string>,
): string | undefined => {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const target = conditionTarget(item, conditions);
      if (target !== undefined) return target;
    }

    return undefined;
  }

  if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (!conditions.has(key)) continue;

      const target = conditionTarget(nested, conditions);
      if (target !== undefined) return target;
    }
  }

  return undefined;
};

/** The target of one subpath in a package's `exports`, wildcards included. */
export const exportTarget = (
  exports: unknown,
  subpath: string,
  conditions: ReadonlySet<string> = SCRIPT_CONDITIONS,
): string | undefined => {
  const map =
    isRecord(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
      ? exports
      : { '.': exports };

  if (subpath in map) return conditionTarget(map[subpath], conditions);

  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0) continue;

    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);

    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    ) {
      const matched = subpath.slice(
        prefix.length,
        subpath.length - suffix.length,
      );
      const target = conditionTarget(value, conditions);

      return target?.replaceAll('*', matched);
    }
  }

  return undefined;
};
