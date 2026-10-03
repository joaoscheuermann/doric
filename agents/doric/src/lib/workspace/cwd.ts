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

/**
 * The one lease-time probe of every working directory a Project holds. Each
 * argument is answered `K` when it still exists, is a directory, and resolves
 * physically inside the root, and `X` when it is missing, is a file, or escapes
 * the root through a symbolic link. Records are NUL-terminated, so a path that
 * is itself valid but contains a newline is named and parsed unambiguously. It
 * is deliberately one command for the whole Project: a resumed host validates
 * every Thread in a single round trip.
 */
const VALIDATE_SCRIPT = String.raw`root=$(cd -- "$1" 2>/dev/null && pwd -P) || exit 1
shift
for p in "$@"; do
  if [ ! -e "$p" ]; then printf 'X %s\0' "$p"; continue; fi
  if [ ! -d "$p" ]; then printf 'X %s\0' "$p"; continue; fi
  physical=$(cd -- "$p" 2>/dev/null && pwd -P) || { printf 'X %s\0' "$p"; continue; }
  case "$physical" in
    "$root"|"$root"/*) printf 'K %s\0' "$p" ;;
    *) printf 'X %s\0' "$p" ;;
  esac
done
`;

/**
 * The subset of `paths` a freshly acquired sandbox still holds as a directory
 * inside the workspace root, or `undefined` when the probe could not run at all.
 * Only an explicit `X` record proves a path invalid: a probe that cannot run (a
 * shell that fails to start, a transient provider fault) says nothing about the
 * paths, so the caller keeps every stored directory instead of clearing them.
 */
export const workingDirectoriesInside = async (
  sandbox: Sandbox,
  root: string,
  paths: readonly string[],
): Promise<ReadonlySet<string> | undefined> => {
  if (paths.length === 0) return new Set();
  const result = await sandbox
    .exec({
      cmd: ['sh', '-c', VALIDATE_SCRIPT, 'cwd-validate', root, ...paths],
    })
    .catch(() => undefined);
  if (result?.exitCode !== 0) return undefined;
  return new Set(
    result.stdout
      .split('\0')
      .filter((record) => record.startsWith('K '))
      .map((record) => record.slice(2)),
  );
};
