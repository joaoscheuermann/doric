// The sandbox vocabulary the file, changes and diff surfaces draw, copied from
// the renderer's `domain/workspace.ts` with the shapes unchanged.

/**
 * Why a Project's sandbox cannot be read. Each state is one the surface
 * explains, so none of them is a thrown failure.
 */
export type ProjectLeaseState =
  | 'missing'
  | 'pending'
  | 'expired'
  | 'unavailable';

/**
 * The sandbox vocabulary: a directory's entries, one file's content, and the
 * workspace diff a Project's Threads share. Every path is relative to the
 * workspace root, which is the empty path.
 */
export type ProjectFileEntry = {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size?: number;
};

/** One tree node: a file, or a directory that carries its own children. */
export type ProjectTreeNode = ProjectFileEntry & {
  /** Present for directories; empty when every child is hidden or ignored. */
  readonly children?: readonly ProjectTreeNode[];
};

export type ProjectFileContent = {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
};

export type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export type ProjectChange = {
  readonly path: string;
  readonly status: ProjectChangeStatus;
  readonly originalPath?: string;
  readonly staged?: boolean;
  readonly unstaged?: boolean;
  readonly indexStatus?: string;
  readonly worktreeStatus?: string;
};

export type ProjectChangeSet = {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
};

/** Every Git repository in the sandbox: one entry per repository. */
export type ProjectDiff = {
  readonly path?: string;
  readonly repositories: readonly ProjectChangeSet[];
};

export type ProjectFilesResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/** The whole sandbox tree in one read, with each directory's children nested. */
export type ProjectTreeResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectTreeNode[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectFileResult =
  | { readonly status: 'ready'; readonly file: ProjectFileContent }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectFileChange = ProjectChange & {
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
};
export type ProjectChanges = {
  readonly path?: string;
  readonly repositories: readonly {
    readonly path: string;
    readonly changes: readonly ProjectFileChange[];
    readonly added: number;
    readonly removed: number;
  }[];
};
export type ProjectChangesResult =
  | { readonly status: 'ready'; readonly changes: ProjectChanges }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };
export type ProjectFileDiff = ProjectFileChange & {
  readonly repository: string;
  readonly original: string;
  readonly modified: string;
  readonly binary: boolean;
  readonly truncated: boolean;
};
export type ProjectFileDiffResult =
  | { readonly status: 'ready'; readonly diff: ProjectFileDiff }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };
export type ProjectDiffResult =
  | { readonly status: 'ready'; readonly diff: ProjectDiff }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };
