// git.open-comparison/v1 (stage 10, §2.7, D10-1): opens one changed file's
// comparison as a tab of the active owner, as the Changes rows did
// (`app.tsx:126-135`): the tab id is today's diff key, its title the file's
// name, its accessible name "<name> changes" and its tooltip the path.
// Opening a comparison whose tab is open selects that tab. The tab's context
// menu holds "Open file" (ui-redesign §4.4 A6), the diff toolbar's command.

import { CommandsV1, defineCommand } from 'bundle/contracts';
import { baseName, joinPath } from 'desktop/reads';
import {
  type CurrentTab,
  type TabRequest as LayoutTabRequest,
  LayoutTabsV1,
} from 'layout/contracts';
import { FileIcon } from 'lucide-react';
import { createElement, type ReactElement } from 'react';

import {
  OPEN_COMPARISON_COMMAND,
  type OpenComparisonInput,
  openComparisonInput,
} from '../contracts/index.js';
import { OPEN_FILE_COMMAND } from './api/peers.js';

/**
 * A tab request whose menu items may carry `icon`, the item's 16 px leading
 * icon (`layout.tabs/v1@1.2.0` TabMenuItem), typed here until git reads that
 * version of the contract.
 */
export type TabRequest = Omit<LayoutTabRequest, 'menu'> & {
  readonly menu?: readonly (NonNullable<LayoutTabRequest['menu']>[number] & {
    readonly icon?: ReactElement;
  })[];
};

/** The tag of the diff tab's element. */
export const FILE_DIFF_TAG = 'git-file-diff';

/** The tab id of one comparison. */
export const comparisonTabId = ({
  projectId,
  repository,
  path,
}: OpenComparisonInput): string =>
  JSON.stringify(['diff', projectId, repository, path]);

/**
 * The tab a comparison opens as. `openFile` is its menu's "Open file" (A6):
 * the entry is fixed when the tab opens, before the diff is read, so a deleted
 * file's tab has it too.
 */
export const comparisonTab = (
  input: OpenComparisonInput,
  openFile?: () => void,
): TabRequest => ({
  id: comparisonTabId(input),
  title: baseName(input.path),
  tag: FILE_DIFF_TAG,
  props: {
    projectId: input.projectId,
    repository: input.repository,
    path: input.path,
  },
  icon: 'file-diff',
  ariaLabel: `${baseName(input.path)} changes`,
  tooltip: input.path,
  ...(openFile === undefined
    ? {}
    : {
        menu: [
          {
            id: 'open-file',
            label: 'Open file',
            icon: createElement(FileIcon),
            run: openFile,
          },
        ],
      }),
});

/**
 * The workspace path a comparison tab compares, when `tab` is one: the row
 * of the Changes view it was opened from is the selected one.
 */
export const comparedPathOf = (
  tab: Pick<CurrentTab, 'id'> | undefined,
): string | undefined => {
  if (tab === undefined) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(tab.id);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(key) ||
    key.length !== 4 ||
    key[0] !== 'diff' ||
    !key.every((part) => typeof part === 'string')
  )
    return undefined;
  return joinPath(key[2] as string, key[3] as string);
};

export const openComparisonCommand = defineCommand({
  id: OPEN_COMPARISON_COMMAND,
  input: openComparisonInput,
  execute: async (input, call, services) => {
    const openFile = () => {
      void services
        .use(CommandsV1)
        .execute(OPEN_FILE_COMMAND, {
          projectId: input.projectId,
          path: joinPath(input.repository, input.path),
        })
        .catch(() => undefined);
    };
    await services.use(LayoutTabsV1).open(comparisonTab(input, openFile), call);
  },
});
