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
  /** Everything read from one Project's sandbox. */
  files: {
    /** The prefix that invalidates the tree, the open file and the diff. */
    ofProject: (projectId: string | undefined) => ['files', projectId],
    tree: (projectId: string | undefined) => ['files', projectId, 'tree'],
    file: (projectId: string | undefined, path: string | undefined) => [
      'files',
      projectId,
      'file',
      path,
    ],
    diff: (projectId: string | undefined) => ['files', projectId, 'diff'],
  },
};
