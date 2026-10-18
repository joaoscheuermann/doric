export type SandboxEntryType = 'directory' | 'file';

/** One visible workspace entry; `path` is always workspace-relative. */
export interface SandboxEntry {
  readonly name: string;
  readonly path: string;
  readonly type: SandboxEntryType;
  /** File size in bytes, present when the listing measured it. */
  readonly size?: number;
}

/** One visible workspace entry and, for directories, its visible children. */
export type SandboxTreeNode = SandboxEntry & {
  /** Present for directories; empty when every child is hidden or ignored. */
  readonly children?: readonly SandboxTreeNode[];
};

/** A directory listing with the workspace visibility rules already applied. */
export interface SandboxListing {
  /** The listed directory, workspace-relative; the workspace root when empty. */
  readonly path: string;
  readonly entries: readonly SandboxEntry[];
}

/** The same rules applied recursively, so each directory carries its children. */
export interface SandboxTree {
  readonly path: string;
  readonly entries: readonly SandboxTreeNode[];
}

export interface SandboxListInput {
  /** Workspace-relative directory; the workspace root when omitted or empty. */
  readonly path?: string;
  /** Glob patterns whose matches stay hidden, as the `tree` tool's `exclude`. */
  readonly exclude?: readonly string[];
}

/**
 * Why a listing could not be produced. Each failure is a distinct answer for the
 * caller: the `tree` tool turns them into its error lines and the host turns them
 * into status codes, so neither re-derives the rule that failed.
 */
export type SandboxListFailure =
  | { readonly status: 'escaped'; readonly message: string }
  | { readonly status: 'missing' }
  | { readonly status: 'not_directory' }
  | { readonly status: 'invalid_exclude'; readonly message: string }
  | { readonly status: 'excluded_root'; readonly name: string };

export type SandboxListResult =
  | ({ readonly status: 'listed' } & SandboxListing)
  | SandboxListFailure;

export type SandboxTreeResult =
  | ({ readonly status: 'listed' } & SandboxTree)
  | SandboxListFailure;

/** One Git repository in the workspace; `path` is always workspace-relative. */
export interface SandboxRepo {
  /** The repository root; the workspace root when empty. */
  readonly path: string;
}

/** The Git repositories a workspace holds, one entry per repository boundary. */
export interface SandboxRepos {
  /** The scanned directory, workspace-relative; the workspace root when empty. */
  readonly path: string;
  readonly repositories: readonly SandboxRepo[];
}

/**
 * Why the repositories could not be listed. There is no caller-supplied path, so
 * a repository scan escapes nothing; only the workspace root itself can fail.
 */
export type SandboxReposFailure =
  | { readonly status: 'missing' }
  | { readonly status: 'not_directory' };

export type SandboxReposResult =
  | ({ readonly status: 'listed' } & SandboxRepos)
  | SandboxReposFailure;

/** What a workspace path currently is; `escaped` never left the workspace root. */
export type WorkspacePathKind = 'directory' | 'file' | 'missing' | 'other';
