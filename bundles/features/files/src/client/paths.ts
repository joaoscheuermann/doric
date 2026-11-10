// A tree path seen from the Files tree's root, the Thread's working directory
// (`rootOf`): the path A8 copies and the directories A5 opens. Both paths are
// workspace-relative, the root `''` the workspace itself.

import { ROOT_PATH } from '../contracts/index.js';

const inside = (root: string, path: string): boolean =>
  root === ROOT_PATH || path.startsWith(`${root}/`);

/** `path` relative to `root`; a path outside it stays whole. */
export const relativeTo = (root: string, path: string): string =>
  root !== ROOT_PATH && inside(root, path) ? path.slice(root.length + 1) : path;

/**
 * The directories between `root` and `path`, outermost first: the rows that
 * hold `path` in a tree rooted at `root`. Undefined when `path` is outside it.
 */
export const ancestorsUnder = (
  root: string,
  path: string,
): readonly string[] | undefined => {
  if (!inside(root, path)) return undefined;
  const parts = relativeTo(root, path).split('/');
  const prefix = root === ROOT_PATH ? '' : `${root}/`;
  return parts
    .slice(0, -1)
    .map((_, index) => prefix + parts.slice(0, index + 1).join('/'));
};
