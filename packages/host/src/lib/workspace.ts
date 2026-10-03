/**
 * The workspace capabilities one active prompt reaches through
 * `host.workspace`.
 *
 * A Thread owns its working directory; the files live in its Project's shared
 * sandbox. Implementations bind both methods to the caller's own Thread, so a
 * model-supplied path can never reach, let alone move, another Thread's
 * directory.
 */
export interface WorkspaceControl {
  /** The Thread's current working directory, absolute inside the sandbox. */
  cwd(): string;
  /**
   * Moves the Thread's working directory. A relative `path` resolves against
   * the current directory, the way `cd` does, and the result must be a
   * directory inside the Project's workspace root or nothing moves.
   */
  setCwd(path: string): Promise<CwdChange>;
}

/**
 * What moving a Thread's working directory did. Every outcome is a value, so a
 * caller reports a refusal instead of handling a thrown failure.
 */
export type CwdChange =
  | { readonly status: 'set'; readonly cwd: string }
  /** The resolved path leaves the workspace root. */
  | { readonly status: 'outside' }
  /** No such path. */
  | { readonly status: 'missing' }
  /** The path exists and is not a directory. */
  | { readonly status: 'not-directory' };
