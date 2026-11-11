// What the window's reads of a Project's sandbox answer (the result shapes of
// `api/reads.ts`), kept apart from the sandbox vocabulary the contracts publish.

import type { ProjectLeaseState } from '../../contracts/reads.js';

export type { ProjectLeaseState } from '../../contracts/reads.js';

/**
 * One workspace entry as the window reads it. A directory carries the children
 * the whole-tree read nested under it.
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

export type ProjectTreeResult =
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly ProjectTreeNode[];
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/** One directory of a per-directory read: its entries, or why it has none. */
export type DirectoryListing =
  | {
      readonly status: 'listed';
      readonly entries: readonly ProjectFileEntry[];
    }
  | { readonly status: 'not_found' | 'not_directory' | 'invalid_path' };

/** Several directories read at once, each keyed by the path it was asked as. */
export type ProjectDirectoriesResult =
  | {
      readonly status: 'ready';
      readonly directories: Readonly<Record<string, DirectoryListing>>;
    }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ProjectFileResult =
  | { readonly status: 'ready'; readonly file: ProjectFileContent }
  | { readonly status: ProjectLeaseState; readonly retryAfterSeconds?: number }
  | { readonly status: 'invalid_path' | 'not_found' };
