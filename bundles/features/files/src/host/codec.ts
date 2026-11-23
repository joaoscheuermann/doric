// `files/v1` over the router (phase 3, S53b): the kernel's domain outcomes as
// the messages `files/v1` 1.4.0 answers (D5).

import type { MessageInitShape } from '@bufbuild/protobuf';
import type { LeaseOutcome } from 'runtime/contracts';
import type { SandboxEntry, SandboxTreeNode } from 'sandbox';

import type {
  ContentResponseSchema,
  CreateDirectoryResponseSchema,
  CreateFileResponseSchema,
  DirectoriesResponseSchema,
  DirectoryResponseSchema,
  ReadBytesResponseSchema,
  SandboxEntrySchema,
  SandboxTreeNodeSchema,
  TreeResponseSchema,
} from '../contracts/gen/doric/files/v1/files_pb.js';
import type {
  ContentRead,
  CreateOutcome,
  DirectoriesRead,
  DirectoryRead,
  TreeRead,
} from '../contracts/index.js';
import type { BytesReadResult } from './reads.js';

type EntryInit = MessageInitShape<typeof SandboxEntrySchema>;
type NodeInit = MessageInitShape<typeof SandboxTreeNodeSchema>;

/** A listed entry as `SandboxEntry`; `size` kept when present. */
const entryOf = (entry: SandboxEntry): EntryInit => ({
  name: entry.name,
  path: entry.path,
  type: entry.type,
  ...(entry.size === undefined ? {} : { size: entry.size }),
});

/** A tree node as `SandboxTreeNode`; absent `children` answer `[]`. */
const nodeOf = (node: SandboxTreeNode): NodeInit => ({
  name: node.name,
  path: node.path,
  type: node.type,
  ...(node.size === undefined ? {} : { size: node.size }),
  children: (node.children ?? []).map(nodeOf),
});

/** `{status}`, with `value` of the ready read only when `status` is `ready`. */
const responseOf = <T, V>(
  o: LeaseOutcome<T>,
  readOf: (value: T) => V,
): { status: string; value?: V } =>
  o.status === 'ready'
    ? { status: o.status, value: readOf(o.value) }
    : { status: o.status };

const createOutcomeOf = (outcome: CreateOutcome) => {
  switch (outcome.status) {
    case 'created':
      return { status: outcome.status, path: outcome.path };
    case 'refused':
      return { status: outcome.status, reason: outcome.reason };
    case 'failed':
      return { status: outcome.status, message: outcome.message };
  }
};

/** The most bytes one `ReadBytes` chunk carries. */
const CHUNK_BYTES = 1_048_576;

/*
 * Each maps a kernel domain outcome to the message `files/v1` 1.4.0
 * answers: `status` copied, and `value` set exactly when `status` is
 * `ready`, holding the read with the same field names.
 * - A tree node without `children` answers `children: []`.
 * - A non-listed or refused read carries only `status` (and, for a
 *   `Directories` entry, `path`).
 * - `size` is kept when present.
 * Pure; never throws for a value of its domain type.
 */

/** `Directory`'s answer; see the rules above. */
export const directoryResponseOf = (
  o: LeaseOutcome<DirectoryRead>,
): MessageInitShape<typeof DirectoryResponseSchema> =>
  responseOf(o, (read) =>
    read.status === 'listed'
      ? {
          status: read.status,
          path: read.path,
          entries: read.entries.map(entryOf),
        }
      : { status: read.status },
  );

/** `Tree`'s answer; see the rules above. */
export const treeResponseOf = (
  o: LeaseOutcome<TreeRead>,
): MessageInitShape<typeof TreeResponseSchema> =>
  responseOf(o, (read) =>
    read.status === 'listed'
      ? {
          status: read.status,
          path: read.path,
          entries: read.entries.map(nodeOf),
        }
      : { status: read.status },
  );

/** `Directories`' answer; see the rules above. */
export const directoriesResponseOf = (
  o: LeaseOutcome<DirectoriesRead>,
): MessageInitShape<typeof DirectoriesResponseSchema> =>
  responseOf(o, (read) => ({
    status: read.status,
    directories: read.directories.map((listing) =>
      listing.status === 'listed'
        ? {
            path: listing.path,
            status: listing.status,
            entries: listing.entries.map(entryOf),
          }
        : { path: listing.path, status: listing.status },
    ),
  }));

/** `Content`'s answer; see the rules above. */
export const contentResponseOf = (
  o: LeaseOutcome<ContentRead>,
): MessageInitShape<typeof ContentResponseSchema> =>
  responseOf(o, (read) =>
    read.status === 'read'
      ? {
          status: read.status,
          path: read.path,
          content: read.content,
          truncated: read.truncated,
          binary: read.binary,
        }
      : { status: read.status },
  );

/** `CreateFile`'s answer; see the rules above. */
export const createFileResponseOf = (
  o: LeaseOutcome<CreateOutcome>,
): MessageInitShape<typeof CreateFileResponseSchema> =>
  responseOf(o, createOutcomeOf);

/** `CreateDirectory`'s answer; see the rules above. */
export const createDirectoryResponseOf = (
  o: LeaseOutcome<CreateOutcome>,
): MessageInitShape<typeof CreateDirectoryResponseSchema> =>
  responseOf(o, createOutcomeOf);

/**
 * The items of a `ReadBytes` answer:
 * - first `{head: {status, value?: BytesRead}}`;
 * - then, only when ready and `read.status === 'read'`, `bytes` cut into
 *   `{chunk}` items of at most 1,048,576 bytes, in order;
 * - none for an empty file.
 */
export const readBytesItemsOf = function* (
  o: LeaseOutcome<BytesReadResult>,
): Iterable<MessageInitShape<typeof ReadBytesResponseSchema>> {
  yield {
    item: {
      case: 'head',
      value: responseOf(o, ({ read }) =>
        read.status === 'read'
          ? {
              status: read.status,
              path: read.path,
              truncated: read.truncated,
              binary: read.binary,
            }
          : { status: read.status },
      ),
    },
  };

  if (o.status !== 'ready' || o.value.read.status !== 'read') return;

  const { bytes } = o.value;

  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    yield {
      item: {
        case: 'chunk',
        value: bytes.subarray(start, start + CHUNK_BYTES),
      },
    };
  }
};
