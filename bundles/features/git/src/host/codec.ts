// The `git.commands/v1` codec (phase 3, S55c): domain answers to the
// generated messages, and a `DiscardRequest` to the domain input.

import type { MessageInitShape } from '@bufbuild/protobuf';

import type {
  BranchesResponseSchema,
  BranchesSchema,
  ChangesResponseSchema,
  DiffResponseSchema,
  DiscardRequest,
  DiscardResponseSchema,
  FileDiffResponseSchema,
  StatusResponseSchema,
  SwitchBranchResponseSchema,
  ThreadGitSchema,
} from '../contracts/gen/doric/git/commands/v1/commands_pb.js';
import type {
  Branches,
  BranchSwitch,
  ChangesRead,
  DiffRead,
  Discard,
  FileDiffRead,
  LeaseOutcome,
  ThreadGit,
  ThreadOutcome,
} from '../contracts/index.js';

type ThreadGitInit = MessageInitShape<typeof ThreadGitSchema>;
type BranchesInit = MessageInitShape<typeof BranchesSchema>;

/** A summary as `ThreadGit`: `repo: false` alone; `null` fields absent. */
const threadGitOf = (git: ThreadGit): ThreadGitInit => {
  if (!git.repo) return { repo: false };
  const { upstream, operation, ...rest } = git;
  return {
    ...rest,
    ...(upstream === null ? {} : { upstream }),
    ...(operation === null ? {} : { operation }),
  };
};

/** Branches as `Branches`; an absent `blocked` stays absent. */
const branchesOf = (value: Branches): BranchesInit => ({
  branches: value.branches.map((branch) => ({ ...branch })),
  ...(value.blocked === undefined ? {} : { blocked: value.blocked }),
});

/** `{status}`, with `value` of the ready answer only when `status` is `ready`. */
const responseOf = <T, V>(
  o: ThreadOutcome<T> | LeaseOutcome<T>,
  readOf: (value: T) => V,
): { status: string; value?: V } =>
  o.status === 'ready'
    ? { status: o.status, value: readOf(o.value) }
    : { status: o.status };

/** A read's `path` when present. */
const pathOf = (read: { readonly path?: string }) =>
  read.path === undefined ? {} : { path: read.path };

/*
 * Each maps a domain answer to the `git.commands/v1` message, `status`
 * copied and `value` set exactly when `status` is `ready`. Pure; never
 * throws for a value of its domain type.
 * - `ThreadGit`: `repo: false` carries only `repo`; `upstream: null` and
 *   `operation: null` are absent (the `thread_git.repo` CEL rule).
 * - `Branches.blocked` absent stays absent.
 * - `refused` carries `message`; `failed` carries `message` and `discarded`.
 * - A read's `path` is kept when present; a refused read (`not_found`,
 *   `invalid_path`) carries only its `status`, with empty lists.
 */

/** `Status`'s answer. */
export const statusResponseOf = (
  o: ThreadOutcome<ThreadGit>,
): MessageInitShape<typeof StatusResponseSchema> => responseOf(o, threadGitOf);

/** `Branches`'s answer. */
export const branchesResponseOf = (
  o: ThreadOutcome<Branches>,
): MessageInitShape<typeof BranchesResponseSchema> => responseOf(o, branchesOf);

/** `SwitchBranch`'s answer. */
export const switchBranchResponseOf = (
  o: BranchSwitch,
): MessageInitShape<typeof SwitchBranchResponseSchema> =>
  o.status === 'refused'
    ? { status: o.status, message: o.message }
    : responseOf(o, branchesOf);

/** `Discard`'s answer. */
export const discardResponseOf = (
  o: Discard,
): MessageInitShape<typeof DiscardResponseSchema> => {
  switch (o.status) {
    case 'refused':
      return { status: o.status, message: o.message };
    case 'failed':
      return {
        status: o.status,
        message: o.message,
        discarded: [...o.discarded],
      };
    default:
      return responseOf(o, (value) => ({ discarded: [...value.discarded] }));
  }
};

/** `Changes`'s answer. */
export const changesResponseOf = (
  o: LeaseOutcome<ChangesRead>,
): MessageInitShape<typeof ChangesResponseSchema> =>
  responseOf(o, (read) =>
    read.status === 'read'
      ? {
          status: read.status,
          ...pathOf(read),
          repositories: read.repositories.map((repository) => ({
            ...repository,
            changes: repository.changes.map((change) => ({ ...change })),
          })),
        }
      : { status: read.status },
  );

/** `Diff`'s answer. */
export const diffResponseOf = (
  o: LeaseOutcome<DiffRead>,
): MessageInitShape<typeof DiffResponseSchema> =>
  responseOf(o, (read) =>
    read.status === 'read'
      ? {
          status: read.status,
          ...pathOf(read),
          repositories: read.repositories.map((repository) => ({
            ...repository,
            changes: repository.changes.map((change) => ({ ...change })),
          })),
        }
      : { status: read.status },
  );

/** `FileDiff`'s answer. */
export const fileDiffResponseOf = (
  o: LeaseOutcome<FileDiffRead>,
): MessageInitShape<typeof FileDiffResponseSchema> =>
  responseOf(o, (read) =>
    read.status === 'read'
      ? { status: read.status, diff: { ...read.diff } }
      : { status: read.status },
  );

/**
 * The domain input of a (protovalidated) `DiscardRequest`: `all: true` →
 * no `paths` (every listed change); otherwise `paths` as sent. Pure.
 */
export const discardInputOf = (
  request: DiscardRequest,
): {
  readonly threadId: string;
  readonly cwd: string;
  readonly repository: string;
  readonly paths?: readonly string[];
} => ({
  threadId: request.threadId,
  cwd: request.cwd,
  repository: request.repository,
  ...(request.all ? {} : { paths: [...request.paths] }),
});
