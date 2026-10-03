import type { Sandbox } from 'sandbox';

/**
 * The sandbox's own answer to "is this directory physically inside the root".
 * `pwd -P` prints the physical path, so a symbolic link that names a path inside
 * the workspace while resolving outside it is caught here; the root is resolved
 * the same way, because the mount a sandbox serves may itself be a link.
 */
const PHYSICAL_SCRIPT = String.raw`inside=$(cd -- "$2" 2>/dev/null && pwd -P) || { printf 'missing\n'; exit 0; }
root=$(cd -- "$1" 2>/dev/null && pwd -P) || { printf 'outside\n'; exit 0; }
case "$inside" in
  "$root"|"$root"/*) printf 'inside\n' ;;
  *) printf 'outside\n' ;;
esac
`;

/**
 * Whether one directory resolves inside the workspace root. The lexical check a
 * resolver makes cannot see a symbolic link, so a path that reads as inside the
 * workspace while pointing outside it is refused here, and every path a tool
 * derives from a working directory stays inside the workspace that directory
 * claims to be in.
 */
export const physicallyInside = async (
  sandbox: Sandbox,
  root: string,
  path: string,
): Promise<boolean> => {
  const result = await sandbox.exec({
    cmd: ['sh', '-c', PHYSICAL_SCRIPT, 'cwd-physical', root, path],
  });

  return result.exitCode === 0 && result.stdout.trim() === 'inside';
};
