import { posix as path } from 'node:path';

import type { LeaseSandbox } from '../sandbox.js';

/**
 * One `.gitignore` line, compiled once. `glob` is undefined when the pattern
 * cannot be compiled (character classes), and the rule then compares the
 * pattern literally.
 */
interface IgnoreRule {
  readonly base: string;
  readonly pattern: string;
  readonly glob: RegExp | undefined;
  readonly directoryOnly: boolean;
  readonly negated: boolean;
}

/**
 * The files under `searchPath` that no `.gitignore` in it hides, sorted, with
 * `.git` and `node_modules` pruned. A file is hidden when a rule matches it or
 * any directory between `searchPath` and the file, and the last matching rule
 * wins, so a negation reopens what an earlier rule hid.
 *
 * Each directory's verdict and its applicable rules are computed once, so the
 * cost grows with files plus directories times rules rather than with files
 * times depth times rules: large workspaces (tens of thousands of files and
 * hundreds of rules) used to hold the event loop for hours.
 */
export const visibleFiles = async (
  sandbox: LeaseSandbox,
  workspaceRoot: string,
  searchPath: string,
): Promise<readonly string[]> => {
  const [files, rules] = await Promise.all([
    findFiles(sandbox, workspaceRoot, searchPath, []),
    readIgnoreRules(sandbox, workspaceRoot, searchPath),
  ]);

  const isVisible = visibility(searchPath, rules);
  const visible: string[] = [];

  for (const [index, file] of files.entries()) {
    // The tool runs in the host's runner process, which also answers every
    // desktop request; yielding keeps a huge workspace from starving them.
    if (index > 0 && index % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (isVisible(file)) {
      visible.push(file);
    }
  }

  return visible;
};

const YIELD_EVERY = 2000;

const visibility = (
  root: string,
  rules: readonly IgnoreRule[],
): ((file: string) => boolean) => {
  const scopedRules = new Map<string, readonly IgnoreRule[]>();
  const hiddenDirectories = new Map<string, boolean>();

  const rulesFor = (directory: string): readonly IgnoreRule[] => {
    let scoped = scopedRules.get(directory);

    if (scoped === undefined) {
      scoped = rules.filter((rule) => contains(rule.base, directory));

      scopedRules.set(directory, scoped);
    }

    return scoped;
  };

  const isHiddenDirectory = (directory: string): boolean => {
    if (directory === root || !contains(root, directory)) {
      return false;
    }

    let hidden = hiddenDirectories.get(directory);

    if (hidden === undefined) {
      hidden =
        isHiddenDirectory(path.dirname(directory)) ||
        isIgnored(directory, true, rulesFor(directory));

      hiddenDirectories.set(directory, hidden);
    }

    return hidden;
  };

  return (file) => {
    const directory = path.dirname(file);

    return (
      !isHiddenDirectory(directory) &&
      !isIgnored(file, false, rulesFor(directory))
    );
  };
};

const isIgnored = (
  fullPath: string,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean => {
  const name = path.basename(fullPath);
  let ignored = false;

  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) {
      continue;
    }

    if (!contains(rule.base, fullPath)) {
      continue;
    }

    // `contains` holds, so the relative path is the suffix after `base/`.
    const relative =
      fullPath === rule.base ? '' : fullPath.slice(rule.base.length + 1);

    const matched =
      rule.glob === undefined
        ? relative === rule.pattern || name === rule.pattern
        : rule.glob.test(relative) || rule.glob.test(name);

    if (matched) {
      ignored = !rule.negated;
    }
  }

  return ignored;
};

const readIgnoreRules = async (
  sandbox: LeaseSandbox,
  workspaceRoot: string,
  searchPath: string,
): Promise<readonly IgnoreRule[]> => {
  const files = await findFiles(sandbox, workspaceRoot, searchPath, [
    '-name',
    '.gitignore',
  ]);

  const groups = await Promise.all(
    files.map(async (file) =>
      parseIgnoreRules(
        path.dirname(file),
        await sandbox.readFile(file).catch(() => ''),
      ),
    ),
  );

  return groups.flat();
};

const parseIgnoreRules = (base: string, text: string): readonly IgnoreRule[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .flatMap((line) => {
      const negated = line.startsWith('!');
      const raw = negated ? line.slice(1) : line;

      if (raw === '') {
        return [];
      }

      const directoryOnly = raw.endsWith('/');
      const pattern = directoryOnly ? raw.slice(0, -1) : raw;

      return [
        { base, pattern, glob: compileGlob(pattern), directoryOnly, negated },
      ];
    });

const findFiles = async (
  sandbox: LeaseSandbox,
  workspaceRoot: string,
  searchPath: string,
  filter: readonly string[],
): Promise<readonly string[]> => {
  const result = await sandbox.exec({
    cwd: workspaceRoot,
    cmd: [
      'find',
      searchPath,
      '(',
      '-name',
      '.git',
      '-o',
      '-name',
      'node_modules',
      ')',
      '-prune',
      '-o',
      '-type',
      'f',
      ...filter,
      '-print',
    ],
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line !== '')
    .map(normalizePath)
    .sort();
};

const compileGlob = (pattern: string): RegExp | undefined => {
  if (pattern.includes('[')) {
    return undefined;
  }

  let source = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*';

      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$+?.()|{}\]]/g, '\\$&');
    }
  }

  return new RegExp(`${source}$`);
};

const contains = (root: string, child: string): boolean =>
  child === root || child.startsWith(`${root}/`);

const normalizePath = (value: string): string => {
  const resolved = path.normalize(path.isAbsolute(value) ? value : `/${value}`);

  return resolved === '/' ? resolved : resolved.replace(/\/+$/, '');
};
