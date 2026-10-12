// files/v1 (stage 10, §3.6): the Project sandbox reads of the file panel and
// the file tab, moved from the runtime's lease reads (`service.ts` files, tree
// and file; `provisional/files.ts` readProjectFile). Each read runs on the
// Project's current lease through `runtime.lease/v1.withLease`, which never
// acquires one and answers the lease state otherwise.

import { Buffer } from 'node:buffer';

import { type Call, defineMethod, defineService } from 'bundle/contracts';
import { RuntimeLeaseV1 } from 'runtime/contracts';
import {
  listSandboxDirectory,
  listSandboxTree,
  type Sandbox,
  workspacePathKind,
} from 'sandbox';

import {
  type ContentRead,
  type DirectoryRead,
  FilesV1,
  filesMethods,
  type TreeRead,
} from '../contracts/index.js';

/** The largest text payload the content read returns. */
export const CONTENT_LIMIT_BYTES = 262_144;

/** Lists one directory level, with the workspace visibility rules. */
export const readDirectory = async (
  sandbox: Sandbox,
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
  sandbox: Sandbox,
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

/** Reads one workspace file as bounded UTF-8 text, never a mangled binary. */
export const readContent = async (
  sandbox: Sandbox,
  path: string,
): Promise<ContentRead> => {
  const kind = await workspacePathKind(sandbox, path);

  if (kind === 'escaped') return { status: 'invalid_path' };
  if (kind === 'missing') return { status: 'not_found' };
  if (kind !== 'file') return { status: 'not_file' };

  // One bounded read: ask for one byte past the cap so truncation is visible.
  const result = await sandbox.exec({
    cmd: ['head', '-c', String(CONTENT_LIMIT_BYTES + 1), '--', path],
  });

  if (result.exitCode !== 0) return { status: 'not_found' };

  const bytes = result.stdoutBytes;
  const truncated = bytes.byteLength > CONTENT_LIMIT_BYTES;
  const binary = bytes.includes(0);
  const content = binary
    ? ''
    : Buffer.from(bytes.subarray(0, CONTENT_LIMIT_BYTES)).toString('utf8');

  return { status: 'read', path, content, truncated, binary };
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
  content: defineMethod({
    expose: 'desktop',
    ...filesMethods.content,
    execute: (input: { readonly path: string }, call: Call, services) =>
      services
        .use(RuntimeLeaseV1, call.scope)
        .withLease((sandbox) => readContent(sandbox, input.path), call),
  }),
});
