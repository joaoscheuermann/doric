// The optional and client peers of the git client, as structural copies of
// their contracts by ID: a composition without files would not map
// `files/contracts`, and the settings bundle publishes no contracts module.
// Each is reached through `whenAvailable`, or used only by the element that
// a peer's own window shows.

import { type CallArg, type Disposable, ref } from 'bundle/contracts';
import type { ProjectTreeNode, ReadState } from 'desktop-reads';

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

/** settings.config/v1 (client, local, R-9.8): the settings window's one autosave draft. */
export interface SettingsConfig {
  draft(call?: CallArg): VersioningDraft | undefined;
  setDraft(
    update: <D extends VersioningDraft>(draft: D) => D,
    call?: CallArg,
  ): void;
  subscribe(listener: () => void, call?: CallArg): Disposable;
}

export const SettingsConfigV1 = ref<SettingsConfig>('settings.config/v1');
