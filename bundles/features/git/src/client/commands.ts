// git.open-comparison/v1 (stage 10, §2.7, D10-1): opens one changed file's
// comparison as a tab of the active owner, as the Changes rows did
// (`app.tsx:126-135`): the tab id is today's diff key, its title the file's
// name, its accessible name "<name> changes" and its tooltip the path.
// Opening a comparison whose tab is open selects that tab.

import { defineCommand } from 'bundle/contracts';
import { baseName, joinPath } from 'desktop-reads';
import {
  type CurrentTab,
  LayoutTabsV1,
  type TabRequest,
} from 'layout/contracts';

import {
  OPEN_COMPARISON_COMMAND,
  type OpenComparisonInput,
  openComparisonInput,
} from '../contracts/index.js';

/** The tag of the diff tab's element. */
export const FILE_DIFF_TAG = 'git-file-diff';

/** The tab id of one comparison. */
export const comparisonTabId = ({
  projectId,
  repository,
  path,
}: OpenComparisonInput): string =>
  JSON.stringify(['diff', projectId, repository, path]);

/** The tab a comparison opens as. */
export const comparisonTab = (input: OpenComparisonInput): TabRequest => ({
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
    await services.use(LayoutTabsV1).open(comparisonTab(input), call);
  },
});
