import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the repository root. It ends in the platform separator,
 * because it comes from a directory URL. To make an absolute path relative to
 * the root, use `path.relative(root, file)`. Do not use
 * `file.slice(root.length + 1)`, as `tests/lint.test.mjs` did before phase 0:
 * it removes one character too many.
 */
export const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The `name` of every readable `package.json` in a workspace directory under
 * `root`: `packages/*`, `tools/*`, `app/*\/*` and `bundles/*\/*`.
 * - A directory without a readable manifest adds nothing.
 * - A manifest whose `name` is not a string adds nothing.
 * - No name appears twice.
 * - The order is the order of discovery and carries no meaning.
 *
 * Reads the disk under `root`. Does not throw for a missing manifest.
 *
 * Moved unchanged from `tests/lint.test.mjs`, as it was before phase 0.
 * @returns {string[]}
 */
export const workspacePackageNames = () => {
  const names = new Set();

  for (const parent of ['packages', 'tools', 'app', 'bundles']) {
    for (const entry of readdirSync(join(root, parent), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;

      const directories =
        parent === 'app' || parent === 'bundles'
          ? readdirSync(join(root, parent, entry.name), { withFileTypes: true })
              .filter((child) => child.isDirectory())
              .map((child) => join(root, parent, entry.name, child.name))
          : [join(root, parent, entry.name)];

      for (const directory of directories) {
        try {
          const manifest = JSON.parse(
            readFileSync(join(directory, 'package.json'), 'utf8'),
          );

          if (typeof manifest.name === 'string') names.add(manifest.name);
        } catch {
          // A directory without a readable manifest is not a workspace package.
        }
      }
    }
  }

  return [...names];
};

/**
 * The source files Git knows of under `directory` (spec section 1, "The test
 * files (D23)").
 *
 * - The paths come from exactly one run of
 *   `git ls-files -z --cached --others --exclude-standard` with `repository`
 *   as the working directory. Tracked and untracked files are listed; files
 *   Git ignores are not.
 * - A listed path is kept when all of these hold:
 *   - it lies under `directory`, or `directory` is `repository`;
 *   - it ends in `/\.[cm]?[jt]sx?$/u`;
 *   - none of its directory segments, relative to `repository`, is
 *     `node_modules` or starts with `dist`. The file's own name is not
 *     tested, so `distribution.ts` is kept and `dist-e2e/x.js` is dropped;
 *   - it exists on disk. A tracked file deleted from the working tree is
 *     dropped.
 *
 * @param {string} directory Absolute, or relative to `repository`.
 * @param {string} [repository=root] Absolute path of a Git working tree.
 * @returns {string[]} Absolute paths, without duplicates, sorted by code-unit
 *   order. An empty array when nothing matches.
 * @throws {Error} When `git` cannot be run or exits non-zero, for example
 *   because `repository` is not a Git working tree. The message includes
 *   Git's stderr.
 */
export const sourceFiles = (directory, repository = root) => {
  const base = resolve(repository);
  const target = resolve(base, directory);
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: base, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  );

  if (result.error) {
    throw new Error(`git ls-files failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }

  const files = new Set();

  for (const path of result.stdout.split('\0')) {
    if (path === '' || !/\.[cm]?[jt]sx?$/u.test(path)) continue;

    const segments = path.split('/').slice(0, -1);
    if (
      segments.some(
        (segment) => segment === 'node_modules' || segment.startsWith('dist'),
      )
    ) {
      continue;
    }

    const file = join(base, path);
    if (target !== base) {
      const inside = relative(target, file);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        continue;
      }
    }

    if (!existsSync(file) || !statSync(file).isFile()) continue;
    files.add(file);
  }

  return [...files].sort();
};

/**
 * The module specifiers written in `source`.
 *
 * A specifier is the text between matching `'` or `"` quotes in one of six
 * forms. Whitespace is allowed after the opening token.
 * - `from '…'`
 * - `require('…')`
 * - `import '…'` at the start of a line
 * - `import('…')` (new)
 * - `import.meta.resolve('…')` (new)
 * - `require.resolve('…')` (new)
 *
 * Template literals and computed specifiers are not read. This is the
 * concept's M2 limit, "Module names built at run time".
 *
 * Returns one item per occurrence, so a specifier written twice appears
 * twice. The order is not guaranteed. Never throws; a source without a
 * specifier gives `[]`.
 * @param {string} source The text of one file.
 * @returns {string[]}
 */
export const importedModules = (source) => {
  const specifiers = [];
  const patterns = [
    /(?:\bfrom|\brequire\(|\bimport\(|\bimport\.meta\.resolve\(|\brequire\.resolve\()\s*(['"])([^'"]+)\1/gu,
    /^\s*import\s*(['"])([^'"]+)\1/gmu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  }

  return specifiers;
};
