/**
 * Every key a `window.doric` read or write caches under, in one place. The
 * shapes are trivial on purpose: a key names what the host was asked, so the
 * invalidation that replaces a manual reload can say exactly which answers are
 * stale.
 */
export const queryKeys = {
  config: ['config'],
  credentials: ['credentials'],
  /** The tools the host's loaded bundles expose, with their declared fields. */
  toolCatalog: ['tools'],
  providerKinds: ['providers', 'kinds'],
  /**
   * One picker's model catalog, keyed by the picker and the read it is on: a
   * catalog is read for the values a draft holds at that moment, so each read
   * is its own entry rather than a re-read of what fields changed.
   */
  providerModels: (instance: string, read: number) => [
    'providers',
    'models',
    instance,
    read,
  ],
  projects: ['projects'],
  /** The Threads of one Project, as the host listed them. */
  threads: (projectId: string) => ['threads', projectId],
  /** One Thread record, read to validate a restored selection. */
  thread: (threadId: string) => ['thread', threadId],
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
