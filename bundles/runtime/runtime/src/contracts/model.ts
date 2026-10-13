import type { SandboxEntry, SandboxSshAccess, SandboxTreeNode } from 'sandbox';
import { z } from 'zod';

import type { PromptResult } from './threads.js';
import type { CwdChange } from './workspace.js';

/*
 * The public domain shapes of Projects and Threads, moved verbatim from
 * agents/doric's workspace types (design 57 §2.1). Every record schema is
 * loose, so a provider's real record validates and travels unchanged.
 */

// Names and colors ----------------------------------------------------------

export const maximumNameLength = 80;

export const normalizeName = (value: string): string => value.trim();

export const isValidName = (value: string): boolean =>
  !value.includes('\0') &&
  Array.from(value).length >= 1 &&
  Array.from(value).length <= maximumNameLength;

/** Produces a valid display name without splitting a Unicode surrogate pair. */
export const nameFromPrompt = (prompt: string): string =>
  Array.from(normalizeName(prompt).replaceAll('\0', '�'))
    .slice(0, maximumNameLength)
    .join('');

/**
 * The colors a Project can be marked with. The host owns this vocabulary: a
 * client names one of these colors, and every surface decides how to paint it.
 */
export const projectColors = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export type ProjectColor = (typeof projectColors)[number];

export const isProjectColor = (value: unknown): value is ProjectColor =>
  typeof value === 'string' &&
  (projectColors as readonly string[]).includes(value);

/** The message of every storage-pressure refusal and pause. */
export const storageMessage =
  'Execution paused: storage is low or unavailable. Free disk space above 10% and resume the queue.';

// Projects and Threads ------------------------------------------------------

export type ProjectState =
  | 'queued'
  | 'ready'
  | 'cancelling'
  | 'cancelled'
  | 'failed';
export type ThreadState = ProjectState | 'running';

export const isTerminal = (state: ThreadState): boolean =>
  state === 'cancelled' || state === 'failed';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly color?: ProjectColor;
  readonly state: ProjectState;
  readonly configRevision: number;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/** The materialized result of a thread's most recent finished prompt. */
export interface ThreadOutcome {
  readonly status: string;
  readonly text: string;
  readonly promptId: string;
  readonly at: string;
}

/** The repository hint of a working directory's own root. */
export type CwdRepo = 'git' | 'github';

/** The one thing a repository can be part-way through. */
export type GitOperation =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'bisect';

/** The Git summary of one Thread's working directory. */
export type ThreadGit =
  | { readonly repo: false }
  | {
      readonly repo: true;
      readonly root: string;
      readonly head: string;
      readonly detached: boolean;
      readonly unborn: boolean;
      readonly upstream: string | null;
      readonly ahead: number;
      readonly behind: number;
      readonly dirty: {
        readonly staged: number;
        readonly modified: number;
        readonly untracked: number;
      };
      readonly conflicted: number;
      readonly operation: GitOperation | null;
      readonly worktree: boolean;
      readonly shallow: boolean;
      readonly stash: number;
      readonly submodules: number;
    };

export interface Thread {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string;
  readonly name: string;
  readonly state: ThreadState;
  readonly lastSequence: number;
  readonly queuePaused?: boolean;
  readonly cwd: string;
  readonly cwdRepo?: CwdRepo;
  readonly activePromptId?: string;
  readonly executionStartedAt?: string;
  readonly lastExecutionMs?: number;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: ThreadOutcome;
}

export type InputSource =
  | { readonly kind: 'user' }
  | {
      readonly kind: 'terminal';
      readonly terminalId: string;
      readonly promptId: string;
    }
  | {
      readonly kind: 'parent';
      readonly threadId: string;
      readonly promptId: string;
    }
  | {
      readonly kind: 'result';
      readonly threadId: string;
      readonly promptId: string;
      readonly requestPromptId: string;
    };

export interface ThreadEvent {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: unknown;
  readonly createdAt: string;
}

export interface Page<Value> {
  readonly items: readonly Value[];
  readonly nextCursor?: string;
}

export type DeleteResult = 'deleted' | 'active' | 'missing';

/** `ThreadResult` of the workspace types, renamed: stage 1 owns that name. */
export type ThreadCreateResult =
  | { readonly status: 'created'; readonly thread: Thread }
  | { readonly status: 'missing' | 'inactive' | 'invalid_parent' };

/** The workspace `PromptResult`: the same shape as the stage-1 one. */
export type PromptAcceptResult = PromptResult;

export type RewindResult =
  | { readonly status: 'accepted'; readonly promptId: string }
  | {
      readonly status: 'missing' | 'inactive' | 'busy' | 'unknown_prompt';
    };

/** The answers one on-demand compaction can give. */
export type CompactResult =
  | {
      readonly status: 'compacted';
      readonly condensedMessages: number;
      readonly retainedMessages: number;
      /** An estimate, not a measurement. */
      readonly tokensFreed: number;
    }
  | {
      readonly status: 'refused';
      readonly reason: 'disabled' | 'missing_history' | 'nothing_to_compact';
    }
  | {
      /** A post-bracket failure the log already carries. */
      readonly status: 'failed';
      readonly code: 'summarizer_failed' | 'unsafe_boundary';
    }
  | {
      readonly status: 'missing' | 'inactive' | 'busy' | 'not_supported';
    };

export type ResumeResult =
  | { readonly status: 'resumed'; readonly thread: Thread }
  | {
      readonly status:
        | 'missing'
        | 'inactive'
        | 'busy'
        | 'unknown_prompt'
        | 'storage_low';
    };

/** The refusals a working-directory move can report. */
export type CwdRefusal = Exclude<CwdChange, { readonly status: 'set' }>;

export type CwdResult =
  | { readonly status: 'updated'; readonly thread: Thread }
  | { readonly status: 'missing' }
  | { readonly status: 'inactive' }
  | { readonly status: 'refused'; readonly change: CwdRefusal };

export type ThreadGitResult =
  | { readonly status: 'ready'; readonly git: ThreadGit }
  | { readonly status: 'missing' | 'inactive' | 'pending' };

// Lease-dependent Project reads --------------------------------------------

export type ProjectLeaseState =
  | 'missing'
  | 'pending'
  | 'unavailable'
  | 'expired';

export type ProjectSsh =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly vmId: string;
      readonly ssh: SandboxSshAccess;
    };

export type ProjectFiles =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly SandboxEntry[];
    }
  | { readonly status: 'invalid_path' | 'not_found' | 'not_directory' };

export type ProjectTree =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly entries: readonly SandboxTreeNode[];
    }
  | { readonly status: 'invalid_path' | 'not_found' | 'not_directory' };

export type ProjectFile =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path: string;
      readonly content: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    }
  | { readonly status: 'invalid_path' | 'not_found' | 'not_file' };

export type ProjectChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

export interface ProjectChange {
  readonly path: string;
  readonly status: ProjectChangeStatus;
}

export interface ProjectChangeSet {
  readonly path: string;
  readonly diff: string;
  readonly changes: readonly ProjectChange[];
}

export type ProjectDiff =
  | { readonly status: ProjectLeaseState }
  | {
      readonly status: 'ready';
      readonly path?: string;
      readonly repositories: readonly ProjectChangeSet[];
    }
  | { readonly status: 'invalid_path' | 'not_found' };

export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface FileChange {
  readonly path: string;
  readonly originalPath?: string;
  readonly status: ChangeStatus;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}

export interface RepositoryChanges {
  readonly path: string;
  readonly changes: readonly FileChange[];
  readonly added: number;
  readonly removed: number;
}

export interface FileDiff extends FileChange {
  readonly repository: string;
  readonly original: string;
  readonly modified: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

export type ProjectChanges =
  | { readonly status: ProjectLeaseState | 'invalid_path' | 'not_found' }
  | {
      readonly status: 'ready';
      readonly path?: string;
      readonly repositories: readonly RepositoryChanges[];
    };

export type ProjectFileDiff =
  | { readonly status: ProjectLeaseState | 'invalid_path' | 'not_found' }
  | { readonly status: 'ready'; readonly diff: FileDiff };

/** One sandbox's own resource usage, or why there is no reading. */
export interface ContainerResources {
  readonly status: 'ready' | 'unavailable';
  readonly at: string;
  readonly cpuPercent?: number;
  readonly cpuCount?: number;
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number;
}

export type ProjectResources =
  | { readonly status: ProjectLeaseState }
  | { readonly status: 'ready'; readonly container: ContainerResources };

// Queue, usage, branches ----------------------------------------------------

export interface QueueItem {
  readonly promptId: string;
  readonly source: InputSource;
  readonly label: string;
  readonly preview: string;
  readonly acceptedAt: string;
  readonly editable: boolean;
  readonly revision: number;
}

export interface QueuedPrompt {
  readonly promptId: string;
  readonly text: string;
  readonly revision: number;
  readonly editable: boolean;
}

export type EditQueueResult =
  | { readonly status: 'updated'; readonly prompt: QueuedPrompt }
  | {
      readonly status:
        | 'missing'
        | 'inactive'
        | 'unknown_prompt'
        | 'not_editable'
        | 'conflict'
        | 'invalid_prompt';
    };

export interface ThreadQueue {
  readonly error?: { readonly code: string; readonly message: string };
  readonly revision: number;
  readonly paused: boolean;
  readonly stopping: boolean;
  readonly current?: QueueItem;
  readonly resumable?: QueueItem;
  readonly items: readonly QueueItem[];
}

export type RemoveQueuedResult =
  | 'removed'
  | 'missing'
  | 'inactive'
  | 'busy'
  | 'unknown_prompt';

export interface UsageTotals {
  readonly calls: number;
  readonly unpricedCalls: number;
  readonly cost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningTokens: number;
}

export interface ContextUsage {
  readonly model: string;
  readonly providerId?: string;
  readonly contextWindowSource?: 'catalog';
  readonly contextWindow?: number;
  readonly inputTokens?: number;
}

export interface ThreadUsage {
  readonly context?: ContextUsage;
  readonly total: UsageTotals;
  readonly threads: readonly (UsageTotals & {
    readonly threadId: string;
    readonly name: string;
    readonly parentThreadId?: string;
  })[];
}

export interface Branch {
  readonly name: string;
  readonly current: boolean;
  readonly commit: string;
  readonly subject: string;
  readonly worktree: string;
}

export interface Branches {
  readonly branches: readonly Branch[];
  readonly blocked?: string;
}

export type BranchResult =
  | { readonly status: 'ready'; readonly value: Branches }
  | { readonly status: 'missing' | 'inactive' | 'pending' }
  | { readonly status: 'refused'; readonly message: string };

// Terminals -----------------------------------------------------------------

export interface Terminal {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly origin: 'agent' | 'user';
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly timeoutMs: number | null;
  readonly state: 'starting' | 'running' | 'exited';
  readonly pty: boolean;
}

export interface TerminalOutput {
  readonly projectId: string;
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
  /** Exclusive UTF-16 offset after this chunk. */
  readonly offset: number;
}

export interface TerminalSnapshot {
  readonly terminal: Terminal;
  readonly output: string;
  readonly offset: number;
  readonly truncated: boolean;
}

// Schemas -------------------------------------------------------------------

/** A status-keyed refusal: a loose object whose `status` is one of `values`. */
const statuses = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.looseObject({ status: z.enum(values) });

const leaseStates = ['missing', 'pending', 'unavailable', 'expired'] as const;

export const projectColorSchema = z.enum(projectColors);

export const projectStateSchema = z.enum([
  'queued',
  'ready',
  'cancelling',
  'cancelled',
  'failed',
]);

export const threadStateSchema = z.enum([
  'queued',
  'ready',
  'running',
  'cancelling',
  'cancelled',
  'failed',
]);

export const inputSourceSchema: z.ZodType<InputSource, InputSource> = z.union([
  z.looseObject({ kind: z.literal('user') }),
  z.looseObject({
    kind: z.literal('terminal'),
    terminalId: z.string(),
    promptId: z.string(),
  }),
  z.looseObject({
    kind: z.literal('parent'),
    threadId: z.string(),
    promptId: z.string(),
  }),
  z.looseObject({
    kind: z.literal('result'),
    threadId: z.string(),
    promptId: z.string(),
    requestPromptId: z.string(),
  }),
]);

export const projectSchema: z.ZodType<Project, Project> = z.looseObject({
  id: z.string(),
  name: z.string(),
  color: projectColorSchema.optional(),
  state: projectStateSchema,
  configRevision: z.number(),
  errorCode: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

export const threadOutcomeSchema: z.ZodType<ThreadOutcome, ThreadOutcome> =
  z.looseObject({
    status: z.string(),
    text: z.string(),
    promptId: z.string(),
    at: z.string(),
  });

export const threadSchema: z.ZodType<Thread, Thread> = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  parentThreadId: z.string().optional(),
  name: z.string(),
  state: threadStateSchema,
  lastSequence: z.number(),
  queuePaused: z.boolean().optional(),
  cwd: z.string(),
  cwdRepo: z.enum(['git', 'github']).optional(),
  activePromptId: z.string().optional(),
  executionStartedAt: z.string().optional(),
  lastExecutionMs: z.number().optional(),
  errorCode: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  result: threadOutcomeSchema.optional(),
});

export const threadEventSchema: z.ZodType<ThreadEvent, ThreadEvent> =
  z.looseObject({
    projectId: z.string(),
    threadId: z.string(),
    promptId: z.string(),
    sequence: z.number(),
    type: z.string(),
    event: z.unknown(),
    createdAt: z.string(),
  });

export const pageSchema = <V>(item: z.ZodType<V, V>) =>
  z.looseObject({
    items: z.array(item),
    nextCursor: z.string().optional(),
  }) as unknown as z.ZodType<Page<V>, Page<V>>;

export const projectPageSchema = pageSchema(projectSchema);
export const threadPageRecordsSchema = pageSchema(threadSchema);

export const deleteResultSchema = z.enum(['deleted', 'active', 'missing']);

export const threadCreateResultSchema: z.ZodType<
  ThreadCreateResult,
  ThreadCreateResult
> = z.union([
  z.looseObject({ status: z.literal('created'), thread: threadSchema }),
  statuses(['missing', 'inactive', 'invalid_parent']),
]);

export const rewindResultSchema: z.ZodType<RewindResult, RewindResult> =
  z.union([
    z.looseObject({ status: z.literal('accepted'), promptId: z.string() }),
    statuses(['missing', 'inactive', 'busy', 'unknown_prompt']),
  ]);

export const compactResultSchema: z.ZodType<CompactResult, CompactResult> =
  z.union([
    z.looseObject({
      status: z.literal('compacted'),
      condensedMessages: z.number(),
      retainedMessages: z.number(),
      tokensFreed: z.number(),
    }),
    z.looseObject({
      status: z.literal('refused'),
      reason: z.enum(['disabled', 'missing_history', 'nothing_to_compact']),
    }),
    z.looseObject({
      status: z.literal('failed'),
      code: z.enum(['summarizer_failed', 'unsafe_boundary']),
    }),
    statuses(['missing', 'inactive', 'busy', 'not_supported']),
  ]);

export const resumeResultSchema: z.ZodType<ResumeResult, ResumeResult> =
  z.union([
    z.looseObject({ status: z.literal('resumed'), thread: threadSchema }),
    statuses(['missing', 'inactive', 'busy', 'unknown_prompt', 'storage_low']),
  ]);

export const cwdRefusalSchema: z.ZodType<CwdRefusal, CwdRefusal> = statuses([
  'outside',
  'missing',
  'not-directory',
]);

export const cwdResultSchema: z.ZodType<CwdResult, CwdResult> = z.union([
  z.looseObject({ status: z.literal('updated'), thread: threadSchema }),
  z.looseObject({ status: z.literal('refused'), change: cwdRefusalSchema }),
  statuses(['missing', 'inactive']),
]);

export const threadGitSchema: z.ZodType<ThreadGit, ThreadGit> = z.union([
  z.looseObject({ repo: z.literal(false) }),
  z.looseObject({
    repo: z.literal(true),
    root: z.string(),
    head: z.string(),
    detached: z.boolean(),
    unborn: z.boolean(),
    upstream: z.string().nullable(),
    ahead: z.number(),
    behind: z.number(),
    dirty: z.looseObject({
      staged: z.number(),
      modified: z.number(),
      untracked: z.number(),
    }),
    conflicted: z.number(),
    operation: z
      .enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])
      .nullable(),
    worktree: z.boolean(),
    shallow: z.boolean(),
    stash: z.number(),
    submodules: z.number(),
  }),
]);

export const threadGitResultSchema: z.ZodType<
  ThreadGitResult,
  ThreadGitResult
> = z.union([
  z.looseObject({ status: z.literal('ready'), git: threadGitSchema }),
  statuses(['missing', 'inactive', 'pending']),
]);

export const sandboxSshAccessSchema: z.ZodType<
  SandboxSshAccess,
  SandboxSshAccess
> = z.looseObject({
  host: z.string(),
  port: z.number(),
  username: z.literal('root'),
  privateKey: z.string(),
  knownHosts: z.string(),
  hostKeyFingerprint: z.string(),
});

const sandboxEntrySchema: z.ZodType<SandboxEntry, SandboxEntry> = z.looseObject(
  {
    name: z.string(),
    path: z.string(),
    type: z.enum(['directory', 'file']),
    size: z.number().optional(),
  },
);

const sandboxTreeNodeSchema: z.ZodType<SandboxTreeNode, SandboxTreeNode> =
  z.looseObject({
    name: z.string(),
    path: z.string(),
    type: z.enum(['directory', 'file']),
    size: z.number().optional(),
    get children() {
      return z.array(sandboxTreeNodeSchema).optional();
    },
  });

export const projectSshSchema: z.ZodType<ProjectSsh, ProjectSsh> = z.union([
  z.looseObject({
    status: z.literal('ready'),
    vmId: z.string(),
    ssh: sandboxSshAccessSchema,
  }),
  statuses(leaseStates),
]);

export const projectFilesSchema: z.ZodType<ProjectFiles, ProjectFiles> =
  z.union([
    z.looseObject({
      status: z.literal('ready'),
      path: z.string(),
      entries: z.array(sandboxEntrySchema),
    }),
    statuses([
      ...leaseStates,
      'invalid_path',
      'not_found',
      'not_directory',
    ] as const),
  ]);

export const projectTreeSchema: z.ZodType<ProjectTree, ProjectTree> = z.union([
  z.looseObject({
    status: z.literal('ready'),
    path: z.string(),
    entries: z.array(sandboxTreeNodeSchema),
  }),
  statuses([
    ...leaseStates,
    'invalid_path',
    'not_found',
    'not_directory',
  ] as const),
]);

export const projectFileSchema: z.ZodType<ProjectFile, ProjectFile> = z.union([
  z.looseObject({
    status: z.literal('ready'),
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    binary: z.boolean(),
  }),
  statuses([...leaseStates, 'invalid_path', 'not_found', 'not_file'] as const),
]);

const projectChangeSetSchema: z.ZodType<ProjectChangeSet, ProjectChangeSet> =
  z.looseObject({
    path: z.string(),
    diff: z.string(),
    changes: z.array(
      z.looseObject({
        path: z.string(),
        status: z.enum([
          'added',
          'modified',
          'deleted',
          'renamed',
          'untracked',
        ]),
      }),
    ),
  });

export const projectDiffSchema: z.ZodType<ProjectDiff, ProjectDiff> = z.union([
  z.looseObject({
    status: z.literal('ready'),
    path: z.string().optional(),
    repositories: z.array(projectChangeSetSchema),
  }),
  statuses([...leaseStates, 'invalid_path', 'not_found'] as const),
]);

const fileChangeShape = {
  path: z.string(),
  originalPath: z.string().optional(),
  status: z.enum([
    'added',
    'modified',
    'deleted',
    'renamed',
    'untracked',
    'conflicted',
  ]),
  staged: z.boolean(),
  unstaged: z.boolean(),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
};

export const fileChangeSchema: z.ZodType<FileChange, FileChange> =
  z.looseObject(fileChangeShape);

export const repositoryChangesSchema: z.ZodType<
  RepositoryChanges,
  RepositoryChanges
> = z.looseObject({
  path: z.string(),
  changes: z.array(fileChangeSchema),
  added: z.number(),
  removed: z.number(),
});

export const fileDiffSchema: z.ZodType<FileDiff, FileDiff> = z.looseObject({
  ...fileChangeShape,
  repository: z.string(),
  original: z.string(),
  modified: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
});

export const projectChangesSchema: z.ZodType<ProjectChanges, ProjectChanges> =
  z.union([
    z.looseObject({
      status: z.literal('ready'),
      path: z.string().optional(),
      repositories: z.array(repositoryChangesSchema),
    }),
    statuses([...leaseStates, 'invalid_path', 'not_found'] as const),
  ]);

export const projectFileDiffSchema: z.ZodType<
  ProjectFileDiff,
  ProjectFileDiff
> = z.union([
  z.looseObject({ status: z.literal('ready'), diff: fileDiffSchema }),
  statuses([...leaseStates, 'invalid_path', 'not_found'] as const),
]);

export const containerResourcesSchema: z.ZodType<
  ContainerResources,
  ContainerResources
> = z.looseObject({
  status: z.enum(['ready', 'unavailable']),
  at: z.string(),
  cpuPercent: z.number().optional(),
  cpuCount: z.number().optional(),
  memoryUsedBytes: z.number().optional(),
  memoryLimitBytes: z.number().optional(),
});

export const projectResourcesSchema: z.ZodType<
  ProjectResources,
  ProjectResources
> = z.union([
  z.looseObject({
    status: z.literal('ready'),
    container: containerResourcesSchema,
  }),
  statuses(leaseStates),
]);

export const queueItemSchema: z.ZodType<QueueItem, QueueItem> = z.looseObject({
  promptId: z.string(),
  source: inputSourceSchema,
  label: z.string(),
  preview: z.string(),
  acceptedAt: z.string(),
  editable: z.boolean(),
  revision: z.number(),
});

export const queuedPromptSchema: z.ZodType<QueuedPrompt, QueuedPrompt> =
  z.looseObject({
    promptId: z.string(),
    text: z.string(),
    revision: z.number(),
    editable: z.boolean(),
  });

export const editQueueResultSchema: z.ZodType<
  EditQueueResult,
  EditQueueResult
> = z.union([
  z.looseObject({ status: z.literal('updated'), prompt: queuedPromptSchema }),
  statuses([
    'missing',
    'inactive',
    'unknown_prompt',
    'not_editable',
    'conflict',
    'invalid_prompt',
  ]),
]);

export const threadQueueSchema: z.ZodType<ThreadQueue, ThreadQueue> =
  z.looseObject({
    error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
    revision: z.number(),
    paused: z.boolean(),
    stopping: z.boolean(),
    current: queueItemSchema.optional(),
    resumable: queueItemSchema.optional(),
    items: z.array(queueItemSchema),
  });

export const removeQueuedResultSchema = z.enum([
  'removed',
  'missing',
  'inactive',
  'busy',
  'unknown_prompt',
]);

const usageTotalsShape = {
  calls: z.number(),
  unpricedCalls: z.number(),
  cost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
};

export const usageTotalsSchema: z.ZodType<UsageTotals, UsageTotals> =
  z.looseObject(usageTotalsShape);

export const contextUsageSchema: z.ZodType<ContextUsage, ContextUsage> =
  z.looseObject({
    model: z.string(),
    providerId: z.string().optional(),
    contextWindowSource: z.literal('catalog').optional(),
    contextWindow: z.number().optional(),
    inputTokens: z.number().optional(),
  });

export const threadUsageSchema: z.ZodType<ThreadUsage, ThreadUsage> =
  z.looseObject({
    context: contextUsageSchema.optional(),
    total: usageTotalsSchema,
    threads: z.array(
      z.looseObject({
        ...usageTotalsShape,
        threadId: z.string(),
        name: z.string(),
        parentThreadId: z.string().optional(),
      }),
    ),
  });

export const branchSchema: z.ZodType<Branch, Branch> = z.looseObject({
  name: z.string(),
  current: z.boolean(),
  commit: z.string(),
  subject: z.string(),
  worktree: z.string(),
});

export const branchResultSchema: z.ZodType<BranchResult, BranchResult> =
  z.union([
    z.looseObject({
      status: z.literal('ready'),
      value: z.looseObject({
        branches: z.array(branchSchema),
        blocked: z.string().optional(),
      }),
    }),
    z.looseObject({ status: z.literal('refused'), message: z.string() }),
    statuses(['missing', 'inactive', 'pending']),
  ]);

export const terminalRecordSchema: z.ZodType<Terminal, Terminal> =
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    threadId: z.string(),
    origin: z.enum(['agent', 'user']),
    command: z.string(),
    cwd: z.string(),
    startedAt: z.string(),
    timeoutMs: z.number().nullable(),
    state: z.enum(['starting', 'running', 'exited']),
    pty: z.boolean(),
  });

export const terminalOutputSchema: z.ZodType<TerminalOutput, TerminalOutput> =
  z.looseObject({
    projectId: z.string(),
    threadId: z.string(),
    terminalId: z.string(),
    data: z.string(),
    offset: z.number(),
  });

export const terminalSnapshotSchema: z.ZodType<
  TerminalSnapshot,
  TerminalSnapshot
> = z.looseObject({
  terminal: terminalRecordSchema,
  output: z.string(),
  offset: z.number(),
  truncated: z.boolean(),
});
