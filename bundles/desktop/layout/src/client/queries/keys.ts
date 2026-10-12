/**
 * Every key a layout read or write caches under, in one place (the settings
 * and chat keys live in those bundles). The
 * shapes are trivial on purpose: a key names what the host was asked, so the
 * invalidation that replaces a manual reload can say exactly which answers are
 * stale.
 */
export const queryKeys = {
  projects: ['projects'],
  /** The host machine's resources, polled by the footer's monitor. */
  hostResources: ['resources', 'host'],
  /** One Project's sandbox resources, or its lease state when there is none. */
  projectResources: (projectId: string) => ['resources', projectId],
  /** The Threads of one Project, as the host listed them. */
  threads: (projectId: string) => ['threads', projectId],
  /** One Thread record, read to validate a restored selection. */
  thread: (threadId: string) => ['thread', threadId],
  threadUsage: (threadId: string | undefined) => ['thread', threadId, 'usage'],
  /** One Thread's git summary, read for the footer's line and popover. */
  threadGit: (threadId: string | undefined, cwd?: string) =>
    cwd === undefined
      ? ['thread', threadId, 'git']
      : ['thread', threadId, 'git', cwd],
  /** Everything read from one Project's sandbox. */
  files: {
    changes: (projectId: string | undefined, cwd: string | undefined) => [
      'files',
      projectId,
      'changes',
      cwd,
    ],
    fileDiff: (projectId: string, repository: string, path: string) => [
      'files',
      projectId,
      'file-diff',
      repository,
      path,
    ],
    /** The prefix that invalidates the tree, the open file and the diff. */
    ofProject: (projectId: string | undefined) => ['files', projectId],
    /**
     * The tree is rooted at the selected Thread's working directory, so that
     * root is part of the key: two Threads with different directories are two
     * different reads rather than one answer reused.
     */
    tree: (projectId: string | undefined, cwd: string | undefined) => [
      'files',
      projectId,
      'tree',
      cwd,
    ],
    file: (projectId: string | undefined, path: string | undefined) => [
      'files',
      projectId,
      'file',
      path,
    ],
    /** The changes view reads the cwd's repository, so the cwd keys it too. */
    diff: (projectId: string | undefined, cwd: string | undefined) => [
      'files',
      projectId,
      'diff',
      cwd,
    ],
  },
};
