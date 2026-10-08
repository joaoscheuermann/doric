/**
 * A Thread has a working directory of its own, stated the way the sandbox states
 * it: absolute, inside the mount the host serves. The sandbox endpoints instead
 * speak the workspace's own vocabulary, where that mount's root is the empty
 * path. These two rules are the only place the two are translated, so nothing
 * else has to know which form a path is in.
 */
import { ROOT_PATH } from './files';

/** The sandbox mount every Thread's working directory lives inside. */
export const SANDBOX_ROOT = '/workspace';

/**
 * The workspace-relative path a sandbox-absolute path names: the mount itself is
 * the empty path, and a path outside the mount has no relative form, so it reads
 * as the root rather than as an invented path.
 */
export const workspacePath = (cwd: string): string => {
  const path = cwd.replace(/\/+$/, '');
  if (path === SANDBOX_ROOT) return ROOT_PATH;
  return path.startsWith(`${SANDBOX_ROOT}/`)
    ? path.slice(SANDBOX_ROOT.length + 1)
    : ROOT_PATH;
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
