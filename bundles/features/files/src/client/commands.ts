// files.open-file/v1 (stage 10, §3.6): opens one sandbox file as a tab of the
// active owner, as the workspace's file rows did (`app.tsx:136-151`): the tab
// id is `file:<path>`, its title the file's name, its tooltip the whole path.
// Opening a file whose tab is open selects that tab.

import { defineCommand } from 'bundle/contracts';
import { baseName } from 'desktop/reads';
import { LayoutTabsV1, type TabRequest } from 'layout/contracts';

import {
  OPEN_FILE_COMMAND,
  type OpenFileInput,
  openFileInput,
} from '../contracts/index.js';

/** The tag of the file tab's element. */
export const FILE_VIEW_TAG = 'files-file-view';

/** The tab id of one file; the tree selects the row of the current one. */
export const fileTabId = (path: string): string => `file:${path}`;

/** The path of a `file:` tab id, else undefined. */
export const filePathOf = (tabId: string | undefined): string | undefined =>
  tabId?.startsWith('file:') ? tabId.slice('file:'.length) : undefined;

/** The tab a file opens as. */
export const fileTab = ({ projectId, path }: OpenFileInput): TabRequest => ({
  id: fileTabId(path),
  title: baseName(path),
  tag: FILE_VIEW_TAG,
  props: { projectId, path },
  icon: 'file',
  tooltip: path,
});

export const openFileCommand = defineCommand({
  id: OPEN_FILE_COMMAND,
  input: openFileInput,
  execute: async (input, call, services) => {
    await services.use(LayoutTabsV1).open(fileTab(input), call);
  },
});
