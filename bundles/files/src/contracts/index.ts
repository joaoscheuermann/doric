// Public contracts of the `files` bundle (stage 10, §3.6).
//
// - `files/v1` (host): the Project sandbox reads the file panel and the file
//   tab make, each run on the Project's current lease without acquiring one.
// - `files.sandbox/v1` (client, local): the window's one tree read per
//   Project and root, shared with the bundles that gate on it.
// - `files.refresh/v1` (client, local): the Project refresh coordinator.
// - `files.open-file/v1` (client command): opens a file tab.

import {
  type CallArg,
  type Disposable,
  disposableSchema,
  functionSchema,
  ref,
} from 'bundle/contracts';
import type { LeaseOutcome } from 'runtime/contracts';
import type { SandboxEntry, SandboxTreeNode } from 'sandbox';
import { z } from 'zod';

export type { LeaseOutcome } from 'runtime/contracts';

export * from './reads.js';

/** One directory level of the workspace (`GET /projects/:id/files`). */
export type DirectoryRead =
  | {
      readonly status: 'listed';
      readonly path: string;
      readonly entries: readonly SandboxEntry[];
    }
  | { readonly status: 'not_found' | 'not_directory' | 'invalid_path' };

/** The whole workspace tree below a path (`GET /projects/:id/tree`). */
export type TreeRead =
  | {
      readonly status: 'listed';
      readonly path: string;
      readonly entries: readonly SandboxTreeNode[];
    }
  | { readonly status: 'not_found' | 'not_directory' | 'invalid_path' };

/** One file as bounded text (`GET /projects/:id/file`). */
export type ContentRead =
  | {
      readonly status: 'read';
      readonly path: string;
      readonly content: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    }
  | { readonly status: 'not_found' | 'not_file' | 'invalid_path' };

/**
 * The Project is `call.scope.projectId` (`services.use(FilesV1, { projectId })`).
 * No method acquires a lease: a Project without one answers its lease state.
 */
export interface Files {
  directory(
    input: { readonly path?: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<DirectoryRead>>;
  tree(
    input: { readonly path?: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<TreeRead>>;
  content(
    input: { readonly path: string },
    call?: CallArg,
  ): Promise<LeaseOutcome<ContentRead>>;
}

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

const leaseStates = z.looseObject({
  status: z.enum(['pending', 'unavailable', 'expired', 'missing']),
});

const ready = <T extends z.ZodType>(value: T) =>
  z.looseObject({ status: z.literal('ready'), value });

const listingRefusal = z.looseObject({
  status: z.enum(['not_found', 'not_directory', 'invalid_path']),
});

const directoryReadSchema = z.union([
  z.looseObject({
    status: z.literal('listed'),
    path: z.string(),
    entries: z.array(sandboxEntrySchema),
  }),
  listingRefusal,
]);

const treeReadSchema = z.union([
  z.looseObject({
    status: z.literal('listed'),
    path: z.string(),
    entries: z.array(sandboxTreeNodeSchema),
  }),
  listingRefusal,
]);

const contentReadSchema = z.union([
  z.looseObject({
    status: z.literal('read'),
    path: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    binary: z.boolean(),
  }),
  z.looseObject({ status: z.enum(['not_found', 'not_file', 'invalid_path']) }),
]);

const optionalPath = z.object({ path: z.string().optional() }).strict();

export const filesMethods = {
  directory: {
    input: optionalPath,
    output: z.union([ready(directoryReadSchema), leaseStates]) as z.ZodType<
      LeaseOutcome<DirectoryRead>,
      LeaseOutcome<DirectoryRead>
    >,
  },
  tree: {
    input: optionalPath,
    output: z.union([ready(treeReadSchema), leaseStates]) as z.ZodType<
      LeaseOutcome<TreeRead>,
      LeaseOutcome<TreeRead>
    >,
  },
  content: {
    input: z.object({ path: z.string() }).strict(),
    output: z.union([ready(contentReadSchema), leaseStates]) as z.ZodType<
      LeaseOutcome<ContentRead>,
      LeaseOutcome<ContentRead>
    >,
  },
} as const;

export const FilesV1 = ref<Files>('files/v1');

// files.sandbox/v1 (client, local) -------------------------------------------

/** A workspace entry as the window reads it. */
export interface ProjectTreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size?: number;
  readonly children?: readonly ProjectTreeNode[];
}

/** What a sandbox read shows: not asked, on its way, the value, or why not. */
export type ReadState<Value> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: Value }
  | {
      readonly status:
        | 'missing'
        | 'pending'
        | 'unavailable'
        | 'expired'
        | 'invalid_path'
        | 'not_found';
      readonly retryAfterSeconds?: number;
    };

export interface TreeObservation {
  readonly read: ReadState<readonly ProjectTreeNode[]>;
  /** The failed read's message, as the toast shows it. */
  readonly error?: string;
  readonly fetching: boolean;
}

/** The tree of one Project, rooted at a workspace-relative directory. */
export interface TreeScope {
  readonly projectId: string;
  /** The raw working directory the tree is rooted at; undefined is the root. */
  readonly cwd?: string;
}

/** Client, local. Observing activates the read; it runs only while observed. */
export interface FilesSandbox {
  observeTree(
    scope: TreeScope,
    listener: (state: TreeObservation) => void,
    call?: CallArg,
  ): Disposable;
}

const treeScopeSchema = z
  .object({ projectId: z.string().min(1), cwd: z.string().optional() })
  .strict();

export const filesSandboxMethods = {
  observeTree: {
    input: z.tuple([
      treeScopeSchema,
      functionSchema<(state: TreeObservation) => void>(),
    ]),
    output: disposableSchema,
  },
} as const;

export const FilesSandboxV1 = ref<FilesSandbox>('files.sandbox/v1');

// files.refresh/v1 (client, local) -------------------------------------------

/** One registrant's reads of a Project: what the coordinator refreshes. */
export interface ProjectReads {
  readonly projectId: string;
  /** True while the registrant shows something (panel open, tab mounted). */
  active(): boolean;
  /**
   * Rereads its active reads. A periodic refresh skips reads in error or not
   * ready, which own their own retry.
   */
  refresh(options: { readonly periodic: boolean }): Promise<void>;
}

export interface FilesRefresh {
  register(reads: ProjectReads, call?: CallArg): Disposable;
  request(
    projectId: string,
    options?: { readonly periodic?: boolean },
    call?: CallArg,
  ): void;
}

const isProjectReads = (value: unknown): value is ProjectReads => {
  if (typeof value !== 'object' || value === null) return false;
  const reads = value as Record<string, unknown>;
  return (
    typeof reads.projectId === 'string' &&
    reads.projectId.length > 0 &&
    typeof reads.active === 'function' &&
    typeof reads.refresh === 'function'
  );
};

export const filesRefreshMethods = {
  register: {
    input: z.custom<ProjectReads>(isProjectReads, {
      message: 'Expected { projectId, active, refresh }.',
    }),
    output: disposableSchema,
  },
  request: {
    input: z.tuple([
      z.string().min(1),
      z.object({ periodic: z.boolean().optional() }).strict().optional(),
    ]),
    output: z.void(),
  },
} as const;

export const FilesRefreshV1 = ref<FilesRefresh>('files.refresh/v1');

// files.open-file/v1 (client command) ----------------------------------------

export const OPEN_FILE_COMMAND = 'files.open-file/v1';

export const openFileInput = z
  .object({ projectId: z.string(), path: z.string() })
  .strict();

export type OpenFileInput = z.output<typeof openFileInput>;
