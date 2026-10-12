// The window's calls to `files/v1` over the client → host bridge, in the
// order the old path made them (moved from the layout's provisional adapter,
// stage 9 §5.8):
//
// 1. the main process's payload guards, with their messages;
// 2. the REST route's own input check, whose 422 became a result;
// 3. the host outcome, turned into what the REST client answered for the
//    route's status (a lease state stays data, `pending` with `Retry-After: 1`);
// 4. a failed call is an `Error` with the message the REST path showed.

import { isContractError, type Services } from 'bundle/contracts';

import {
  type ContentRead,
  type Files,
  FilesV1,
  type LeaseOutcome,
  type TreeRead,
} from '../../contracts/index.js';
import type {
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const fileEntryFrom = (value: unknown): ProjectFileEntry => {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string' ||
    (value.type !== 'directory' && value.type !== 'file') ||
    (value.size !== undefined && typeof value.size !== 'number')
  ) {
    return invalidResponse();
  }
  return value as ProjectFileEntry;
};

const treeNodeFrom = (value: unknown): ProjectTreeNode => {
  const entry = fileEntryFrom(value);
  if (!isRecord(value) || value.children === undefined) return entry;
  if (!Array.isArray(value.children)) return invalidResponse();
  return { ...entry, children: value.children.map(treeNodeFrom) };
};

const fileContentFrom = (value: unknown): ProjectFileContent => {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.content !== 'string' ||
    typeof value.truncated !== 'boolean' ||
    typeof value.binary !== 'boolean'
  ) {
    return invalidResponse();
  }
  return {
    path: value.path,
    content: value.content,
    truncated: value.truncated,
    binary: value.binary,
  };
};

type NotReady =
  | {
      readonly status: 'missing' | 'unavailable' | 'expired';
    }
  | { readonly status: 'pending'; readonly retryAfterSeconds: number }
  | { readonly status: 'invalid_path' | 'not_found' };

/** A lease state as the REST client read it: `pending` carried `Retry-After: 1`. */
const leaseState = (
  status: 'pending' | 'unavailable' | 'expired' | 'missing',
): NotReady =>
  status === 'pending' ? { status, retryAfterSeconds: 1 } : { status };

/**
 * A refusal of the read itself: `not_found` was the 404
 * `project_path_not_found`; every other refusal was a 422.
 */
const refusal = (status: string): NotReady =>
  status === 'not_found' ? { status: 'not_found' } : { status: 'invalid_path' };

const call = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    throw hostFailure(error);
  }
};

/** The REST query: the workspace root sent no path. */
const pathOf = (path: string): { readonly path?: string } =>
  path === '' ? {} : { path };

export interface FilesReads {
  /** The whole tree below `path` (the root when undefined). */
  tree(projectId: string, path?: string): Promise<ProjectTreeResult>;
  /** One file as bounded text. */
  file(projectId: string, path: string): Promise<ProjectFileResult>;
}

/** The reads over `files/v1`, each scoped to its Project. */
export const createFilesReads = (
  files: (projectId: string) => Files,
): FilesReads => ({
  tree: async (projectId, path) => {
    const id = identifier(projectId);
    const at = relativePath(path);
    const outcome: LeaseOutcome<TreeRead> = await call(() =>
      files(id).tree(pathOf(at)),
    );
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    const read = outcome.value as unknown;
    if (!isRecord(read)) return invalidResponse();
    if (read.status !== 'listed') return refusal(String(read.status));
    if (typeof read.path !== 'string' || !Array.isArray(read.entries))
      return invalidResponse();
    return {
      status: 'ready',
      path: read.path,
      entries: read.entries.map(treeNodeFrom),
    };
  },
  file: async (projectId, path) => {
    const id = identifier(projectId);
    const at = relativePath(path);
    // The content route requires a path; the root sent none (422).
    if (at === '') return { status: 'invalid_path' };
    const outcome: LeaseOutcome<ContentRead> = await call(() =>
      files(id).content({ path: at }),
    );
    if (outcome.status !== 'ready') return leaseState(outcome.status);
    const read = outcome.value as unknown;
    if (!isRecord(read)) return invalidResponse();
    if (read.status !== 'read') return refusal(String(read.status));
    return { status: 'ready', file: fileContentFrom(read) };
  },
});

/** The reads bound to a part's services. */
export const filesReadsOf = (services: Services): FilesReads =>
  createFilesReads((projectId) => services.use(FilesV1, { projectId }));
