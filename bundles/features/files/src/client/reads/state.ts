// What the tree and the file view show for each sandbox read (moved from
// `desktop-reads`): the state a read leaves on screen, and the path chain the
// breadcrumb names.

import type { ReadState } from '../../contracts/index.js';
import { ROOT_PATH } from '../../contracts/reads.js';
import type {
  ProjectFileContent,
  ProjectFileResult,
  ProjectTreeNode,
  ProjectTreeResult,
} from './project-files.js';

/** The breadcrumb's root segment names the workspace root. */
export const ROOT_NAME = 'workspace';

/** The sentence shown under a payload the host cut short, if it did. */
export const truncationNotice = (truncated: boolean): string | undefined =>
  truncated
    ? 'This file is larger than the read limit, so only its first part is shown.'
    : undefined;

export type PathSegment = {
  readonly name: string;
  readonly path: string;
};

/**
 * The breadcrumb chain from the workspace root down to `path`. The first
 * segment is the root, named for it; every later segment carries the path it
 * selects.
 */
export const pathSegments = (path: string): readonly PathSegment[] => {
  const segments: PathSegment[] = [{ name: ROOT_NAME, path: ROOT_PATH }];
  let current = ROOT_PATH;
  for (const name of path.split('/')) {
    if (name.length === 0) continue;
    current = current === ROOT_PATH ? name : `${current}/${name}`;
    segments.push({ name, path: current });
  }
  return segments;
};

/**
 * What the tree shows. A reread that fails keeps a tree already on screen and
 * falls back to the loading shape otherwise, while the surface explains the
 * failure beside it.
 */
export const treeReadState = (
  result: ProjectTreeResult | undefined,
  failed: boolean,
): ReadState<readonly ProjectTreeNode[]> => {
  if (result?.status === 'ready') {
    return { status: 'ready', value: result.entries };
  }
  if (result !== undefined && !failed) return result;
  return { status: 'loading' };
};

/**
 * What the open file shows. Background reads and failures keep the last text
 * available; only the first read needs a loading placeholder.
 */
export const fileReadState = (
  result: ProjectFileResult | undefined,
  loading: boolean,
  failed: boolean,
): ReadState<ProjectFileContent> => {
  if (result?.status === 'ready')
    return { status: 'ready', value: result.file };
  if (loading) return { status: 'loading' };
  if (failed || result === undefined) return { status: 'idle' };
  return result;
};
