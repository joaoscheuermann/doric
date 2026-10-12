// Workspace-relative paths, the way every read surface names them. Generic
// string handling: nothing here knows what a path holds.

/** The workspace root: every path this surface carries is relative to it. */
export const ROOT_PATH = '';

/** The path of `name` inside `dir`. */
export const joinPath = (dir: string, name: string): string =>
  dir === ROOT_PATH ? name : `${dir}/${name}`;

/** The directory that holds `path`; the root holds a name with no separator. */
export const parentPath = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? ROOT_PATH : path.slice(0, separator);
};

/** The last segment of `path`: the file or directory it names, not its chain. */
export const baseName = (path: string): string => {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? path : path.slice(separator + 1);
};

/** How many trailing components a shortened path keeps when none is asked for. */
const TRAILING_COMPONENTS = 2;

/** The mark that stands in for the components dropped from the left. */
const ELLIPSIS = '…';

/**
 * A path shortened to its last few components, prefixed with an ellipsis when
 * anything was dropped: `/home/me/projetos/doric` reads `…/projetos/doric`. A
 * path already that short is left whole, so a short directory never loses a part
 * of itself to a mark that hides nothing.
 */
export const compactPath = (
  path: string,
  keep: number = TRAILING_COMPONENTS,
): string => {
  const components = path
    .split('/')
    .filter((component) => component.length > 0);
  if (components.length <= keep) return path;
  return `${ELLIPSIS}/${components.slice(components.length - keep).join('/')}`;
};
