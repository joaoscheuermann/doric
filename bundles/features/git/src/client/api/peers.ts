// The optional and client peers of the git client, as structural copies of
// their contracts by ID: a composition without files or chat would not map
// `files/contracts` or `chat/contracts`. Each is reached through
// `whenAvailable`, or used only by the element that a peer's own window shows.
// `settings.config/v1` is not here: git requires it, and takes it from
// `settings/contracts`.

import {
  type CallArg,
  type Disposable,
  defineHook,
  defineHooks,
  ref,
} from 'bundle/contracts';
import type { ProjectTreeNode, ReadState } from 'files/contracts';
import { z } from 'zod';

/** What chat's `onThreadUpdateHook` hands git: a live event, or an updated record. */
export type ChatThreadUpdate =
  | { readonly kind: 'event'; readonly event: { readonly event: unknown } }
  | { readonly kind: 'updated'; readonly thread: unknown };

/**
 * chat.hooks/v2 (D12): the one hook git observes, matched by contract ID only
 * and reached through `HooksV1.whenAvailable`; git has no chat package line.
 */
export const ChatHooksV2 = defineHooks('chat.hooks/v2', {
  onThreadUpdateHook: defineHook({
    kind: 'observe',
    input: z.object({
      projectId: z.string(),
      threadId: z.string(),
      threadName: z.string(),
      update: z.custom<ChatThreadUpdate>(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'kind' in value &&
          (value.kind === 'event' || value.kind === 'updated'),
      ),
    }),
  }),
});

export type ThreadUpdateInput = z.output<
  (typeof ChatHooksV2)['hooks']['onThreadUpdateHook']['input']
>;

/** files.sandbox/v1 (client, local): the tree read the Changes view is gated by. */
export interface TreeObservation {
  readonly read: ReadState<readonly ProjectTreeNode[]>;
  readonly error?: string;
  readonly fetching: boolean;
}

export interface FilesSandbox {
  observeTree(
    scope: { readonly projectId: string; readonly cwd?: string },
    listener: (state: TreeObservation) => void,
    call?: CallArg,
  ): Disposable;
}

export const FilesSandboxV1 = ref<FilesSandbox>('files.sandbox/v1');

/** files.refresh/v1 (client, local): the Project refresh coordinator. */
export interface ProjectReads {
  readonly projectId: string;
  active(): boolean;
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

export const FilesRefreshV1 = ref<FilesRefresh>('files.refresh/v1');

/** files.open-file/v1 (client command): opens one sandbox file as a tab. */
export const OPEN_FILE_COMMAND = 'files.open-file/v1';

/** The configuration fields the Versioning section edits. */
export interface VersioningDraft {
  readonly gitCredentialId?: string;
  readonly githubCredentialId?: string;
}
