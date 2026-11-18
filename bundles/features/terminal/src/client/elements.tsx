// The terminal client's elements (stage 10, §3.10), built inside a factory
// the activation calls, so importing this module touches no DOM global
// [D10-7]. Each renders in light DOM with `display: contents` and reads the
// activation's store, never an element's own state (D9-17).

import { NavigationV1, type Services } from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import { defineReactElement } from 'desktop/ui/react-element';
import { toast } from 'desktop/ui/sonner';
import { TerminalIcon } from 'lucide-react';

import type { TerminalApi } from './api.js';
import type { Terminal } from './domain/terminals.js';
import { useService, useSubscribed } from './hooks.js';
import type { TerminalWatchApi } from './output-watch.js';
import {
  LayoutTabsV2,
  type RecordsSource,
  RuntimeRecordsV1,
  WorkspaceSelectionV1,
} from './peers.js';
import { TerminalRows } from './rows/terminal-rows.js';
import type { TerminalStore } from './store.js';
import { terminalIdOfTab } from './tab.js';
import { TerminalView } from './view/terminal-view.js';

export { TERMINAL_VIEW_TAG } from './tab.js';

export interface TerminalClient {
  readonly api: TerminalApi;
  readonly watches: TerminalWatchApi;
  readonly store: TerminalStore;
  /** What a terminal row's click does (navigate, then show or open it). */
  readonly open: (terminal: Terminal) => void;
}

/** Terminal rows sit one level below their owning Thread. */
export const rowsDepth = (
  records: Pick<RecordsSource, 'thread'>,
  threadId: string,
): number => {
  let depth = 1;
  const seen = new Set<string>([threadId]);
  let parent = records.thread(threadId)?.parentThreadId;
  while (parent !== undefined && !seen.has(parent)) {
    const record = records.thread(parent);
    if (record === undefined) break;
    seen.add(parent);
    depth += 1;
    parent = record.parentThreadId;
  }
  return depth;
};

/** The selected Thread's id, while a Project and a Thread are selected. */
const useSelectedThreadId = (services: Services): string | undefined => {
  const selection = useService(services, WorkspaceSelectionV1);
  return useSubscribed(
    selection,
    () => {
      const { projectId, threadId } = (
        selection as NonNullable<typeof selection>
      ).current();
      return projectId === undefined ? undefined : threadId;
    },
    undefined,
  );
};

export const defineTerminalElements = (client: TerminalClient) => {
  const { api, watches, store } = client;
  const useTerminals = (): readonly Terminal[] =>
    useSubscribed(store, () => store.terminals(), []);

  function NewTerminalButton({ services }: { readonly services: Services }) {
    const threadId = useSelectedThreadId(services);
    return (
      <Button
        variant="ghost"
        size="icon-sm"
        className="mr-2 shrink-0 [app-region:no-drag]"
        aria-label="New terminal"
        title="Open terminal"
        disabled={!threadId}
        onClick={threadId ? () => void store.create(threadId) : undefined}
      >
        <TerminalIcon />
      </Button>
    );
  }

  function Rows({
    services,
    'thread-id': threadId,
  }: {
    readonly services: Services;
    readonly 'thread-id'?: string;
  }) {
    const records = useService(services, RuntimeRecordsV1);
    const tabs = useService(services, LayoutTabsV2);
    const navigation = useService(services, NavigationV1);
    const terminals = useTerminals();
    const own = terminals.filter((item) => item.threadId === threadId);
    // The selected tab is a terminal's only on this Thread's route; the rows
    // listen to the tabs only while the Thread has terminals.
    const selectedId = useSubscribed(
      own.length > 0 ? tabs : undefined,
      () =>
        navigation === undefined ||
        navigation.current()?.params.threadId !== threadId
          ? undefined
          : terminalIdOfTab(tabs?.current()?.id),
      undefined,
    );
    if (threadId === undefined || records === undefined) return null;
    return (
      <TerminalRows
        terminals={own}
        depth={rowsDepth(records, threadId)}
        selectedId={selectedId}
        onOpen={client.open}
        onStop={store.stop}
        onRename={store.rename}
        onError={(message) => toast.error(message)}
      />
    );
  }

  function View({
    terminalId,
    showHeader,
  }: {
    readonly terminalId?: string;
    readonly showHeader?: boolean;
  }) {
    // The store keeps each unchanged record, so another terminal's update
    // leaves this view's snapshot, and the view, as they were.
    const session = useSubscribed(
      store,
      () => store.terminals().find((terminal) => terminal.id === terminalId),
      undefined,
    );
    return session ? (
      <TerminalView
        api={api}
        watches={watches}
        session={session}
        showHeader={showHeader ?? true}
      />
    ) : null;
  }

  return {
    newButton: defineReactElement<object>({
      props: [],
      render: NewTerminalButton,
    }),
    // The sidebar mounts `<terminal-rows thread-id>` with React, which sets
    // the property of that name when the element has one.
    rows: defineReactElement<{ readonly 'thread-id'?: string }>({
      props: ['thread-id'],
      render: Rows,
    }),
    view: defineReactElement<{
      readonly terminalId?: string;
      readonly showHeader?: boolean;
    }>({
      props: ['terminalId', 'showHeader'],
      render: View,
    }),
    // The mark the layout draws on a terminal's tab (`iconTag`).
    tabIcon: defineReactElement<object>({
      props: [],
      render: () => <TerminalIcon />,
    }),
  };
};
