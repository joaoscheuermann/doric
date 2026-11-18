import { HooksV1, type Services } from 'bundle/contracts';
import { LayoutTabsV2 } from 'layout/contracts';
import { RuntimeRecordsV1 } from 'runtime/contracts';

import { WorkspaceHooksV1 } from '../api/workspace-hooks.js';

/** The element a Thread tab shows: the Thread's conversation panel. */
const THREAD_PANEL_TAG = 'chat-thread-panel';
/** The element drawn as a Thread tab's 16 px icon. */
const THREAD_TAB_ICON = 'chat-thread-tab-icon';

interface OpenedTab {
  readonly projectId: string;
  readonly threadId: string;
  readonly title: string;
}

const report = (what: string) => (reason: unknown) => {
  console.error(`Doric: the Thread tab could not ${what}:`, reason);
};

/**
 * Opens the chat's Thread tab when `workspace.hooks/v1` asks, and keeps every
 * tab it opened titled and closed with the mirror; returns the cleanup.
 *
 * The tab is `{ id: 'thread:<id>', title, tag: 'chat-thread-panel', iconTag:
 * 'chat-thread-tab-icon', openBottom: true, props: { projectId, threadId } }`,
 * opened through `layout.tabs/v2` with the Thread's name from
 * `runtime.records/v1` ("Untitled" without one). On every change of the
 * mirror, for each tab it opened: while the Project's Threads are loading or
 * not described the tab is left as it is; a Thread missing from the described
 * list closes its tab in every owner, and the tab is forgotten; otherwise a
 * changed name retitles it in every owner. A failed call is reported with
 * `console.error`.
 */
export const watchThreadTabs = (services: Services): (() => void) => {
  const tabs = services.use(LayoutTabsV2);
  const records = services.use(RuntimeRecordsV1);
  const opened = new Map<string, OpenedTab>();

  const open = async (input: {
    readonly projectId: string;
    readonly threadId: string;
  }): Promise<void> => {
    const { projectId, threadId } = input;
    const id = `thread:${threadId}`;
    const title = records.thread(threadId)?.name || 'Untitled';
    try {
      await tabs.open({
        id,
        title,
        tag: THREAD_PANEL_TAG,
        props: { projectId, threadId },
        iconTag: THREAD_TAB_ICON,
        openBottom: true,
      });
      opened.set(id, { projectId, threadId, title });
    } catch (reason) {
      report('open')(reason);
    }
  };

  const reconcile = () => {
    for (const [id, tab] of [...opened]) {
      const read = records.threads(tab.projectId);
      if (read.status === 'loading' || read.value === undefined) continue;
      const thread = read.value.find((item) => item.id === tab.threadId);
      if (thread === undefined) {
        opened.delete(id);
        void tabs.close({ id, everyOwner: true }).catch(report('close'));
        continue;
      }
      const title = thread.name || 'Untitled';
      if (title === tab.title) continue;
      opened.set(id, { ...tab, title });
      void tabs
        .retitle({ id, title, everyOwner: true })
        .catch(report('retitle'));
    }
  };

  const hook = services
    .use(HooksV1)
    .whenAvailable(WorkspaceHooksV1, (workspace) => {
      const registration = workspace.onOpenThreadHook(open);
      return () => registration.dispose();
    });
  const changes = records.subscribe(reconcile);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    hook.dispose();
    changes.dispose();
    opened.clear();
  };
};
