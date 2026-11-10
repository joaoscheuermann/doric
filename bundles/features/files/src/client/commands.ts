// files.open-file/v1 (stage 10, §3.6): opens one sandbox file as a tab of the
// active owner, as the workspace's file rows did (`app.tsx:136-151`): the tab
// id is `file:<path>`, its title the file's name, its tooltip the whole path.
// Opening a file whose tab is open selects that tab. The tab's context menu
// holds "Reveal in Files" (§4.4 A5, S16, `layout.tabs/v1@1.2.0` `menu`).

import { defineCommand, type Services } from 'bundle/contracts';
import { baseName } from 'desktop/reads';
import {
  LayoutPanelV2,
  LayoutTabsV1,
  LayoutWorkspaceV1,
  type TabRequest,
} from 'layout/contracts';
import { FilesIcon } from 'lucide-react';
import { createElement, type ReactElement } from 'react';

import {
  OPEN_FILE_COMMAND,
  type OpenFileInput,
  openFileInput,
} from '../contracts/index.js';
import { ancestorsUnder } from './paths.js';
import { rootOf } from './sandbox-store.js';
import { expansionScope, expansionStore } from './stores/expansion.js';

/** The tag of the file tab's element. */
export const FILE_VIEW_TAG = 'files-file-view';

/** The tab id of one file; the tree selects the row of the current one. */
export const fileTabId = (path: string): string => `file:${path}`;

/** The path of a `file:` tab id, else undefined. */
export const filePathOf = (tabId: string | undefined): string | undefined =>
  tabId?.startsWith('file:') ? tabId.slice('file:'.length) : undefined;

/**
 * A5 Reveal in Files: opens the file's ancestor directories under the Files
 * tree's root (the selected Thread's working directory), shows the Files
 * panel and selects the file's tab, whose row the tree then selects. A file
 * outside that root, or of another Project than the selected one, only shows
 * the panel. Nothing it calls is awaited or allowed to throw: it runs from a
 * menu entry.
 */
export const revealFile = (
  services: Services,
  { projectId, path }: OpenFileInput,
): void => {
  try {
    const { project, thread } = services.use(LayoutWorkspaceV1).selection();
    const root = rootOf(thread?.cwd);
    const ancestors =
      project?.id === projectId ? ancestorsUnder(root, path) : undefined;
    if (ancestors !== undefined) {
      expansionStore
        .getState()
        .expand(expansionScope(projectId, root), ancestors);
    }
  } catch {
    // Without the workspace's selection there is no tree to open.
  }
  try {
    services.use(LayoutPanelV2).select('files');
  } catch {
    // The panel is the layout's; without it there is nothing to show.
  }
  try {
    void services
      .use(LayoutTabsV1)
      .focus({ id: fileTabId(path) })
      .catch(() => undefined);
  } catch {
    // The tab is already where the reader opened its menu.
  }
};

/**
 * A tab request whose menu entries may carry a leading `icon` element
 * (`layout.tabs/v1@1.2.0` `TabMenuItem.icon`), typed here until layout's
 * contract declares it.
 */
type FileTabRequest = Omit<TabRequest, 'menu'> & {
  readonly menu?: readonly (NonNullable<TabRequest['menu']>[number] & {
    readonly icon?: ReactElement;
  })[];
};

/** The tab a file opens as; with `services`, its menu holds Reveal in Files. */
export const fileTab = (
  input: OpenFileInput,
  services?: Services,
): FileTabRequest => ({
  id: fileTabId(input.path),
  title: baseName(input.path),
  tag: FILE_VIEW_TAG,
  props: { projectId: input.projectId, path: input.path },
  icon: 'file',
  tooltip: input.path,
  ...(services === undefined
    ? {}
    : {
        menu: [
          {
            id: 'reveal-in-files',
            label: 'Reveal in Files',
            icon: createElement(FilesIcon),
            run: () => revealFile(services, input),
          },
        ],
      }),
});

export const openFileCommand = defineCommand({
  id: OPEN_FILE_COMMAND,
  input: openFileInput,
  execute: async (input, call, services) => {
    await services.use(LayoutTabsV1).open(fileTab(input, services), call);
  },
});
