// The sandbox vocabulary the files, git and resources surfaces share (moved
// from `desktop-reads`, stage BWP-11). It is published through this contracts
// module, which a window loads by its own specifier, so it imports nothing at
// runtime: the workspace root is restated here as the empty path it is.

/** The workspace root: every path this surface carries is relative to it. */
export const ROOT_PATH = '';

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

/**
 * Why a Project's sandbox cannot be read. Each state is one the surface
 * explains, so none of them is a thrown failure.
 */
export type ProjectLeaseState =
  | 'missing'
  | 'pending'
  | 'expired'
  | 'unavailable';

export type SandboxStatus = ProjectLeaseState | 'invalid_path' | 'not_found';

/**
 * The sentence a Project's sandbox shows when the surface cannot read it. A
 * queued lease carries the host's own retry hint, so the surface repeats it
 * rather than inventing a wait of its own.
 */
export const sandboxNotice = (
  status: SandboxStatus,
  retryAfterSeconds?: number,
): string => {
  switch (status) {
    case 'pending':
      return retryAfterSeconds === undefined
        ? 'The sandbox is still being prepared.'
        : `The sandbox is still being prepared; the host suggests trying again in ${retryAfterSeconds} seconds.`;
    case 'expired':
      return 'The sandbox lease for this Project expired, so its files are no longer readable.';
    case 'unavailable':
      return 'The sandbox is unavailable, so this Project has no files to show.';
    case 'missing':
      return 'This Project has no sandbox yet, so it has no files to show.';
    case 'invalid_path':
      return 'That path is not inside the workspace.';
    case 'not_found':
      return 'That path is no longer in the workspace.';
  }
};
