// The window's calls to `files/v1` over Connect, in the order the old path made
// them (moved from the layout's provisional adapter, stage 9 §5.8):
//
// 1. the main process's payload guards, with their messages;
// 2. the REST route's own input check, whose 422 became a result;
// 3. the host outcome, read back from the `FilesService` messages as what the
//    REST client answered for the route's status (a lease state stays data,
//    `pending` with `Retry-After: 1`);
// 4. a failed call is an `Error` with the message the REST path showed; a
//    `ConnectError` reads as its Doric error (`fromConnectError`).
//
// Slice S65d: the host is `FilesService`'s generated client over Connect.

import { type Client, ConnectError } from '@connectrpc/connect';
import {
  type ClientServices,
  fromConnectError,
  isContractError,
  type Services,
} from 'bundle/contracts';

import {
  type ContentRead as ContentReadMessage,
  type DirectoriesRead as DirectoriesReadMessage,
  type DirectoryListingRead as DirectoryListingReadMessage,
  FilesService,
  type SandboxEntry as SandboxEntryMessage,
  type SandboxTreeNode as SandboxTreeNodeMessage,
  type TreeRead as TreeReadMessage,
} from '../../contracts/gen/doric/files/v1/files_pb.js';
import { DIRECTORIES_LIMIT } from '../../contracts/index.js';
import type {
  DirectoryListing,
  ProjectDirectoriesResult,
  ProjectFileContent,
  ProjectFileEntry,
  ProjectFileResult,
  ProjectTreeNode,
  ProjectTreeResult,
} from '../reads/project-files.js';

export const readMessages = {
  unavailable: 'Doric backend is unavailable.',
  invalidResponse: 'Doric returned an invalid response.',
  /** The REST 500 envelope: any other host failure. */
  failed: 'The request could not be completed.',
  invalidIdentifier: 'The item identifier is invalid.',
  invalidPath: 'The workspace path is invalid.',
} as const;

const maximumPathLength = 4096;

const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new Error(readMessages.invalidIdentifier);
  }
  return value;
};

/** `undefined` is the workspace root, `''`. */
const relativePath = (value: unknown): string => {
  if (value === undefined) return '';
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    value.length > maximumPathLength ||
    value.startsWith('/') ||
    value.split('/').includes('..')
  ) {
    throw new Error(readMessages.invalidPath);
  }
  return value;
};

/** The message a failed host call shows, as the REST path showed it. */
export const hostFailure = (error: unknown): Error => {
  if (isContractError(error)) {
    if (
      error.code === 'unavailable' ||
      error.code === 'disconnected' ||
      error.code === 'generation_lost'
    ) {
      return new Error(readMessages.unavailable);
    }
    if (error.code === 'invalid_output') {
      return new Error(readMessages.invalidResponse);
    }
  }
  return new Error(readMessages.failed);
};

const invalidResponse = (): never => {
  throw new Error(readMessages.invalidResponse);
};

const call = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw hostFailure(
      error instanceof ConnectError ? fromConnectError(error) : error,
    );
  }
};

type NotReady =
  | {
      readonly status: 'missing' | 'unavailable' | 'expired';
    }
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'invalid_path' | 'not_found' };

const leaseStatuses = ['pending', 'unavailable', 'expired', 'missing'] as const;

/** A lease state as the REST client read it: `pending` carried `Retry-After: 1`. */
const leaseState = (status: string): NotReady => {
  if (!(leaseStatuses as readonly string[]).includes(status)) {
    return invalidResponse();
  }
  return status === 'pending'
    ? { status, retryAfterSeconds: 1 }
    : { status: status as Exclude<(typeof leaseStatuses)[number], 'pending'> };
};

/**
 * A refusal of the read itself: `not_found` was the 404
 * `project_path_not_found`; every other refusal was a 422.
 */
const refusal = (status: string): NotReady =>
  status === 'not_found' ? { status: 'not_found' } : { status: 'invalid_path' };

/** The REST query: the workspace root sent no path. */
const pathOf = (path: string): { readonly path?: string } =>
  path === '' ? {} : { path };

/** A message's entry fields: a listing entry, or a tree node ('s own). */
type EntryFields = Pick<SandboxEntryMessage, 'name' | 'path' | 'type' | 'size'>;

/** One workspace entry, as the window reads it. */
const fileEntryFrom = (entry: EntryFields): ProjectFileEntry => {
  if (entry.type !== 'directory' && entry.type !== 'file') {
    return invalidResponse();
  }
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };
};

/** One tree node: the entry and, when it has any, the children nested in it. */
const treeNodeFrom = (node: SandboxTreeNodeMessage): ProjectTreeNode => {
  const entry = fileEntryFrom(node);
  return node.children.length === 0
    ? entry
    : { ...entry, children: node.children.map(treeNodeFrom) };
};

const fileContentFrom = (read: ContentReadMessage): ProjectFileContent => {
  if (
    read.path === undefined ||
    read.content === undefined ||
    read.truncated === undefined ||
    read.binary === undefined
  ) {
    return invalidResponse();
  }
  return {
    path: read.path,
    content: read.content,
    truncated: read.truncated,
    binary: read.binary,
  };
};

/** The REST answer of a tree read: `ready`'s value is the whole tree read. */
const treeResult = (read: TreeReadMessage): ProjectTreeResult => {
  if (read.status !== 'listed') return refusal(read.status);
  if (read.path === undefined) return invalidResponse();
  return {
    status: 'ready',
    path: read.path,
    entries: read.entries.map(treeNodeFrom),
  };
};

/** One directory of a `directories` answer, as the window reads it. */
const directoryListingFrom = (
  read: DirectoryListingReadMessage,
): { readonly path: string; readonly listing: DirectoryListing } => {
  if (read.status === 'listed') {
    return {
      path: read.path,
      listing: { status: 'listed', entries: read.entries.map(fileEntryFrom) },
    };
  }
  if (
    read.status === 'not_found' ||
    read.status === 'not_directory' ||
    read.status === 'invalid_path'
  ) {
    return { path: read.path, listing: { status: read.status } };
  }
  return invalidResponse();
};

const directoriesResult = (
  read: DirectoriesReadMessage,
): ProjectDirectoriesResult => {
  if (read.status !== 'listed') return refusal(read.status);
  const directories: Record<string, DirectoryListing> = {};
  for (const { path, listing } of read.directories.map(directoryListingFrom)) {
    directories[path] = listing;
  }
  return { status: 'ready', directories };
};

export interface FilesReads {
  /** The whole tree below `path` (the root when undefined). */
  tree(projectId: string, path?: string): Promise<ProjectTreeResult>;
  /**
   * Several directories one level each, in one call: each keyed by its path,
   * with the rules the tree rooted at `root` applies.
   */
  directories(
    projectId: string,
    paths: readonly string[],
    root?: string,
  ): Promise<ProjectDirectoriesResult>;
  /** One file as bounded text. */
  file(projectId: string, path: string): Promise<ProjectFileResult>;
}

/** The `FilesService` calls the reads make. */
export type FilesCalls = Pick<
  Client<typeof FilesService>,
  'tree' | 'directories' | 'content'
>;

/** The reads over `FilesService`, each scoped to its Project. */
export const createFilesReads = (
  files: (projectId: string) => FilesCalls,
): FilesReads => ({
  tree: async (projectId, path) => {
    const id = identifier(projectId);
    const at = relativePath(path);
    const outcome = await call(() => files(id).tree(pathOf(at)));
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    if (outcome.value === undefined) return invalidResponse();
    return treeResult(outcome.value);
  },
  directories: async (projectId, paths, root) => {
    const id = identifier(projectId);
    const asked = [...new Set(paths.map(relativePath))];
    const at = relativePath(root);
    if (asked.length === 0 || asked.length > DIRECTORIES_LIMIT)
      throw new Error(readMessages.invalidPath);
    const outcome = await call(() =>
      files(id).directories({
        paths: asked,
        ...(at === '' ? {} : { root: at }),
      }),
    );
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    if (outcome.value === undefined) return invalidResponse();
    return directoriesResult(outcome.value);
  },
  file: async (projectId, path) => {
    const id = identifier(projectId);
    const at = relativePath(path);
    // The content route requires a path; the root sent none (422).
    if (at === '') return { status: 'invalid_path' };
    const outcome = await call(() => files(id).content({ path: at }));
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    if (outcome.value === undefined) return invalidResponse();
    const read = outcome.value;
    if (read.status !== 'read') return refusal(read.status);
    return { status: 'ready', file: fileContentFrom(read) };
  },
});

/** The reads bound to a part's services: `FilesService` over Connect, scoped to the Project. */
export const filesReadsOf = (services: Services): FilesReads =>
  createFilesReads((projectId) =>
    (services as ClientServices).use(FilesService, { projectId }),
  );
