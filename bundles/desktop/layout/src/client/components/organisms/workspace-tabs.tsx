// The tab panel beside the conversation: every tab is another bundle's
// element (`layout.tabs/v2`) since WP-10N moved the file, diff and terminal
// tabs to the files, git and terminal bundles.

import { UiV1 } from 'bundle/contracts';
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
} from 'desktop/ui/context-menu';
import { ElementHost } from 'desktop/ui/element-host';
import { TabStrip } from 'desktop/ui/panels';
import { TabsContent } from 'desktop/ui/tabs';
import { XIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { LayoutTabsV2, type TabMenuItem } from '../../../contracts/index.js';
import type {
  WorkspaceTabs as TabsState,
  WorkspaceTab,
} from '../../domain/workspace-tabs.js';
import { layoutServices } from '../../services/layout-services.js';
import { workspaceStore } from '../../stores/workspace.js';
import { workspaceTabsStore } from '../../stores/workspace-tabs.js';

export function WorkspaceTabBar({
  state,
  threadId,
}: {
  readonly state: TabsState;
  readonly threadId: string;
}) {
  const actions = workspaceTabsStore.getState();
  const close = (id: string) => {
    void layoutServices()
      .use(LayoutTabsV2)
      .close({ id, threadId })
      .catch((reason: unknown) => workspaceStore.getState().fail(reason));
  };
  return (
    <TabStrip
      variant="project"
      label="Files, changes, terminals and threads"
      selected={state.selected}
      onMove={(from, to) => actions.move(threadId, from, to)}
      onClose={close}
      tabMenu={(id) => (
        <TabMenu
          items={tabMenuOf(state.items.find((tab) => tab.id === id))}
          onClose={() => close(id)}
        />
      )}
      items={state.items.flatMap((tab) =>
        tab.kind === 'element'
          ? [
              {
                // Another bundle's tab (layout.tabs/v2): its title, and
                // from 1.1.0 the icon, aria label and tooltip it asked for.
                id: tab.id,
                label: tab.title,
                ariaLabel: tab.ariaLabel ?? tab.title,
                title: tab.tooltip ?? tab.title,
                icon: tabIcon(tab),
              },
            ]
          : [],
      )}
    />
  );
}

const tabMenuOf = (tab: WorkspaceTab | undefined) =>
  tab?.kind === 'element' ? (tab.menu ?? []) : [];

/**
 * One entry the opener stated, its icon leading; without one it is inset.
 * `inset` is left out rather than false: the item writes it to `data-inset`,
 * whose presence alone insets it.
 */
const OpenerEntry = ({ item }: { readonly item: TabMenuItem }) => (
  <ContextMenuItem
    inset={item.icon === undefined ? true : undefined}
    variant={item.destructive ? 'destructive' : 'default'}
    onClick={item.run}
  >
    {item.icon}
    {item.label}
  </ContextMenuItem>
);

/**
 * A viewer tab's context menu (S15, Figma `layout/ContextMenu` 29:5570): the
 * opener's non-destructive entries (`layout.tabs/v2` `menu`), a
 * separator, "Close tab" (which closes it as its close button does), then the
 * opener's destructive entries last, behind a separator. "Close tab" carries
 * an icon, so an entry without one is inset to align with the labels.
 */
function TabMenu({
  items,
  onClose,
}: {
  readonly items: readonly TabMenuItem[];
  readonly onClose: () => void;
}) {
  const leading = items.filter((item) => !item.destructive);
  const destructive = items.filter((item) => item.destructive);
  return (
    <>
      {leading.length > 0 && (
        <>
          <ContextMenuGroup>
            {leading.map((item) => (
              <OpenerEntry key={item.id} item={item} />
            ))}
          </ContextMenuGroup>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuGroup>
        <ContextMenuItem onClick={onClose}>
          <XIcon />
          Close tab
        </ContextMenuItem>
      </ContextMenuGroup>
      {destructive.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            {destructive.map((item) => (
              <OpenerEntry key={item.id} item={item} />
            ))}
          </ContextMenuGroup>
        </>
      )}
    </>
  );
}

export function WorkspaceTabs({ state }: { readonly state: TabsState }) {
  return (
    <section
      aria-label="Files, changes, terminals and threads"
      className="flex h-full min-h-0 flex-col"
    >
      {/* Keep panels in stable DOM order when their triggers are moved. */}
      {state.items
        .slice()
        .sort((left, right) => left.id.localeCompare(right.id))
        .flatMap((tab) =>
          tab.kind === 'element'
            ? [
                <TabsContent
                  key={tab.id}
                  value={tab.id}
                  keepMounted
                  hidden={state.selected !== tab.id}
                  className="min-h-0 flex-1 data-[active=true]:flex data-[active=true]:flex-col"
                  data-active={state.selected === tab.id}
                >
                  <ElementTab element={tab.element} />
                </TabsContent>,
              ]
            : [],
        )}
    </section>
  );
}

/**
 * The trigger icon of an element tab: the element `ui/v1` creates for the
 * tab's `iconTag`, with the tab's props; without `iconTag`, none.
 */
function tabIcon(tab: WorkspaceTab) {
  if (tab.iconTag === undefined) return null;
  return (
    <ElementHost
      ui={layoutServices().use(UiV1)}
      tag={tab.iconTag}
      {...(tab.props === undefined ? {} : { props: tab.props })}
    />
  );
}

/** Keeps another bundle's tab element mounted in a host of this panel. */
function ElementTab({ element }: { readonly element: object }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = element as Node;
    host.current?.append(node);
    return () => {
      node.parentNode?.removeChild(node);
    };
  }, [element]);
  return <div ref={host} className="min-h-0 flex-1" />;
}
