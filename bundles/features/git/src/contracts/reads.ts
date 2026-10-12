// The changed-file vocabulary the window reads and draws (moved from
// `desktop-reads`, stage BWP-11). Types only: a window loads this module
// through its own specifier, and the schemas that check these shapes are
// written in `index.ts`.

import type { ProjectLeaseState } from 'files/contracts';

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

export type ProjectFileChange = ProjectChange & {
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
};

/** The changes of one Project, one entry per Git repository in the reached path. */
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

/**
 * The mark a changed path carries in a tree, as the tree draws it: the text its
 * label reads, the count a directory badge shows, and the colour, the letter and
 * the strike a changed file's row shows. Git states the marks; the tree draws
 * them without knowing what a change is.
 */
export interface ChangeMark {
  readonly description: string;
  readonly count: number;
  readonly tone?: string;
  readonly letter?: string;
  readonly struck?: boolean;
}
