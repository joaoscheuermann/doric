// files/v1 (stage 10, §3.6): the Project sandbox reads of the file panel and
// the file tab, moved from the runtime's lease reads (`service.ts` files, tree
// and file; `provisional/files.ts` readProjectFile). Each read runs on the
// Project's current lease through `runtime.lease/v1.withLease`, which never
// acquires one and answers the lease state otherwise.

import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

import { type Call, defineMethod, defineService } from 'bundle/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';
import {
  listSandboxDirectories,
  listSandboxDirectory,
  listSandboxTree,
  workspacePathKind,
} from 'sandbox';

import {
  type ContentInput,
  type ContentRead,
  type CreateInput,
  type DirectoriesInput,
  type DirectoriesRead,
  type DirectoryListingRead,
  type DirectoryRead,
  FilesV1,
  filesMethods,
  type TreeRead,
} from '../contracts/index.js';
import type { ProjectSandbox } from './lease.js';
import { createEntry } from './writes.js';

/** The largest text payload the content read returns. */
export const CONTENT_LIMIT_BYTES = 262_144;

/** The most bytes a base64 content read returns (a font, an image). */
export const BYTES_LIMIT = 4_194_304;

/** Lists one directory level, with the workspace visibility rules. */
export const readDirectory = async (
  sandbox: ProjectSandbox,
  path?: string,
): Promise<DirectoryRead> => {
  const listing = await listSandboxDirectory(sandbox, { path: path ?? '' });
  if (listing.status === 'listed')
    return { status: 'listed', path: listing.path, entries: listing.entries };
  if (listing.status === 'missing') return { status: 'not_found' };
  // `invalid_exclude` and `excluded_root` are unreachable: no excludes are sent.
  return {
    status:
      listing.status === 'not_directory' ? 'not_directory' : 'invalid_path',
  };
};

/** Lists the whole tree below `path` in one read. */
export const readTree = async (
  sandbox: ProjectSandbox,
  path?: string,
): Promise<TreeRead> => {
  const listing = await listSandboxTree(sandbox, { path: path ?? '' });
  if (listing.status === 'listed')
    return { status: 'listed', path: listing.path, entries: listing.entries };
  if (listing.status === 'missing') return { status: 'not_found' };
  // `invalid_exclude` and `excluded_root` are unreachable: no excludes are sent.
  return {
    status:
      listing.status === 'not_directory' ? 'not_directory' : 'invalid_path',
  };
};

/**
 * Lists several directories one level each in one sandbox command (1.3.0), with
 * the rules the whole tree read applies from `root`; one answer per asked path.
 */
export const readDirectories = async (
  sandbox: ProjectSandbox,
  input: DirectoriesInput,
): Promise<DirectoriesRead> => {
  const listings = await listSandboxDirectories(sandbox, {
    paths: input.paths,
    ...(input.root === undefined ? {} : { root: input.root }),
  });
  return {
    status: 'listed',
    directories: listings.map((listing, index): DirectoryListingRead => {
      const path = input.paths[index] as string;
      if (listing.status === 'listed')
        return { path, status: 'listed', entries: listing.entries };
      if (listing.status === 'missing') return { path, status: 'not_found' };
      return {
        path,
        status:
          listing.status === 'not_directory' ? 'not_directory' : 'invalid_path',
      };
    }),
  };
};

/**
 * Reads one workspace file as bounded UTF-8 text, never a mangled binary, or
 * as its bytes in base64 under BYTES_LIMIT.
 */
export const readContent = async (
  sandbox: ProjectSandbox,
  path: string,
  encoding: 'utf8' | 'base64' = 'utf8',
): Promise<ContentRead> => {
  const kind = await workspacePathKind(sandbox, path);

  if (kind === 'escaped') return { status: 'invalid_path' };
  if (kind === 'missing') return { status: 'not_found' };
  if (kind !== 'file') return { status: 'not_file' };

  const limit = encoding === 'base64' ? BYTES_LIMIT : CONTENT_LIMIT_BYTES;

  // One bounded read: ask for one byte past the cap so truncation is visible.
  const result = await sandbox.exec({
    cmd: ['head', '-c', String(limit + 1), '--', path],
  });

  if (result.exitCode !== 0) return { status: 'not_found' };

  const bytes = result.stdoutBytes;
  const truncated = bytes.byteLength > limit;
  const binary = bytes.includes(0);
  const kept = Buffer.from(bytes.subarray(0, limit));
  const content =
    encoding === 'base64'
      ? kept.toString('base64')
      : binary
        ? ''
        : kept.toString('utf8');

  return { status: 'read', path, content, truncated, binary };
};

/** A `ReadBytes` read's outcome; mirrors `doric.files.v1.BytesRead`. */
export type BytesRead =
  | {
      readonly status: 'read';
      readonly path: string;
      readonly truncated: boolean;
      readonly binary: boolean;
    }
  | { readonly status: 'not_found' | 'not_file' | 'invalid_path' };

/** What `readBytes` answers: the outcome and, when read, the kept bytes. */
export interface BytesReadResult {
  readonly read: BytesRead;
  /** At most `BYTES_LIMIT` bytes; empty unless `read.status === 'read'`. */
  readonly bytes: Uint8Array;
}

/** A `ProjectSandbox` that can also stream one file's bytes. */
export interface ProjectBytesSandbox extends ProjectSandbox {
  /**
   * The first bytes of the file at the absolute `path`: at most `max`
   * bytes. Reading stops once `max` bytes arrived. Rejects as the sandbox
   * read fails.
   */
  fileBytes(path: string, max: number): Promise<Uint8Array>;
}

/**
 * Reads one workspace file's exact bytes under `BYTES_LIMIT`, with the
 * rules of `readContent`:
 * - `invalid_path` when the path leaves the workspace;
 * - `not_found` when it is missing; `not_file` when it is not a file;
 * - otherwise `read`, with `truncated` when the file holds more than
 *   `BYTES_LIMIT` bytes, and `binary` when the bytes read hold a NUL.
 *
 * `path` in the answer is the path as asked. Rejects as `fileBytes` or the
 * kind probe rejects (no `not_found` fallback for a read that fails after
 * the probe said `file`; Q4).
 */
export const readBytes = async (
  sandbox: ProjectBytesSandbox,
  path: string,
): Promise<BytesReadResult> => {
  const kind = await workspacePathKind(sandbox, path);
  const none = new Uint8Array();

  if (kind === 'escaped')
    return { read: { status: 'invalid_path' }, bytes: none };
  if (kind === 'missing') return { read: { status: 'not_found' }, bytes: none };
  if (kind !== 'file') return { read: { status: 'not_file' }, bytes: none };

  // The resolution `workspacePathKind` applies: an absolute path is not
  // joined under the root a second time.
  const absolute = posix.isAbsolute(path)
    ? posix.normalize(path)
    : posix.join(sandbox.root, path);
  // One byte past the cap, so truncation is visible.
  const read = await sandbox.fileBytes(absolute, BYTES_LIMIT + 1);
  const bytes = read.subarray(0, BYTES_LIMIT);

  return {
    read: {
      status: 'read',
      path,
      truncated: read.byteLength > BYTES_LIMIT,
      binary: read.includes(0),
    },
    bytes,
  };
};

/** `files/v1`, over the calling Project's lease. */
export const filesService = defineService(FilesV1, {
  directory: defineMethod({
    expose: 'desktop',
    ...filesMethods.directory,
    execute: (input: { readonly path?: string }, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => readDirectory(sandbox, input.path), call),
  }),
  tree: defineMethod({
    expose: 'desktop',
    ...filesMethods.tree,
    execute: (input: { readonly path?: string }, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => readTree(sandbox, input.path), call),
  }),
  directories: defineMethod({
    expose: 'desktop',
    ...filesMethods.directories,
    execute: (input: DirectoriesInput, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => readDirectories(sandbox, input), call),
  }),
  content: defineMethod({
    expose: 'desktop',
    ...filesMethods.content,
    execute: (input: ContentInput, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease(
          (sandbox) => readContent(sandbox, input.path, input.encoding),
          call,
        ),
  }),
  createFile: defineMethod({
    expose: 'desktop',
    ...filesMethods.createFile,
    execute: (input: CreateInput, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => createEntry(sandbox, input, 'file'), call),
  }),
  createDirectory: defineMethod({
    expose: 'desktop',
    ...filesMethods.createDirectory,
    execute: (input: CreateInput, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => createEntry(sandbox, input, 'directory'), call),
  }),
});
