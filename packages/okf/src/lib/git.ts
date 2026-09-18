import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Ignore } from 'ignore';

const require = createRequire(import.meta.url);
const createIgnore = require('ignore') as () => Ignore;

type ScopedIgnore = {
  readonly base: string;
  readonly matcher: Ignore;
};

/** Filters normalized repository paths through explicit and scoped gitignore rules. */
export const filterIgnored = async (
  root: string,
  paths: readonly string[],
  patterns: readonly string[],
): Promise<readonly string[]> => {
  const explicit = createIgnore().add(patterns);
  const matchers: ScopedIgnore[] = [];

  const ignoreFiles = paths
    .filter(isGitIgnore)
    .sort(
      (left, right) => depth(left) - depth(right) || left.localeCompare(right),
    );

  for (const file of ignoreFiles) {
    if (explicit.ignores(file) || isIgnored(file, matchers)) {
      continue;
    }

    const matcher = await readMatcher(root, file);

    if (matcher) {
      matchers.push(matcher);
    }
  }

  return paths.filter(
    (file) =>
      !isGitIgnore(file) &&
      !explicit.ignores(file) &&
      !isIgnored(file, matchers),
  );
};

const readMatcher = async (
  root: string,
  file: string,
): Promise<ScopedIgnore | undefined> => {
  try {
    const matcher = createIgnore().add(
      await fs.promises.readFile(path.join(root, ...file.split('/')), 'utf-8'),
    );
    const folder = path.posix.dirname(file);

    return { base: folder === '.' ? '' : folder, matcher };
  } catch {
    return;
  }
};

const isIgnored = (
  file: string,
  matchers: readonly ScopedIgnore[],
): boolean => {
  let ignored = false;

  for (const { base, matcher } of matchers) {
    if (base && !file.startsWith(`${base}/`)) {
      continue;
    }

    const result = matcher.test(base ? file.slice(base.length + 1) : file);

    if (result.ignored) {
      ignored = true;
    }

    if (result.unignored) {
      ignored = false;
    }
  }

  return ignored;
};

const depth = (file: string): number => file.split('/').length;

const isGitIgnore = (file: string): boolean =>
  path.posix.basename(file) === '.gitignore';
