// The Project panel's frame (WP-10P, R-9.2), moved out of the provisional
// files sidebar: the "Project views" tab strip over the `layout.panel` region
// items, the `layout.panel.header` region before the panel's own toggle, the
// selected view, and the `project-files-footer` bar with the
// `layout.panel.footer` region. Since WP-10N every view is a region item
// (files and git); built-in entries remain possible but none is passed.

import type { RegionEntry } from 'bundle/contracts';
import { TabStrip } from 'desktop-ui/panels';
import { Separator } from 'desktop-ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from 'desktop-ui/sidebar';
import { Tabs } from 'desktop-ui/tabs';
import { FileDiffIcon, FileIcon, FilesIcon, TerminalIcon } from 'lucide-react';
import { createElement, type ReactNode, useState } from 'react';

import { movedPanelOrder, panelOrder } from '../../domain/panel-order.js';
import { ElementHost } from '../molecules/element-host.js';

/** A view the layout draws itself (a provisional feature). */
export interface PanelBuiltIn {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly badge?: ReactNode;
}

/** The icon names a `layout.panel` item may carry. */
export const panelIcon = (name: unknown): ReactNode => {
  switch (name) {
    case 'files':
      return <FilesIcon />;
    case 'file-diff':
      return <FileDiffIcon />;
    case 'file':
      return <FileIcon />;
    case 'terminal':
      return <TerminalIcon />;
    default:
      return null;
  }
};

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** A `<core-region name>`: `display: contents`, no role of its own. */
const Region = ({ name }: { readonly name: string }) =>
  createElement('core-region', { name });

type ProjectPanelProps = {
  readonly active: string;
  readonly onActiveChange: (id: string) => void;
  readonly builtIns?: readonly PanelBuiltIn[];
  /** What a built-in view shows; drawn while one is selected. */
  readonly builtInContent?: ReactNode;
  /** The `layout.panel` region items. */
  readonly items: readonly RegionEntry[];
  /** The footer's built-in content, before the `layout.panel.footer` region. */
  readonly footer?: ReactNode;
};

/**
 * The sandbox, as a right-hand panel beside the conversation. Its views are
 * icon-only tabs in the header in place of a title, because they name what
 * the panel is showing and select it among a set, in the order the reader
 * drags them into. The `layout.panel.header` region (the files bundle's
 * toggle, WP-10N) is the last control at the corner.
 */
export function ProjectPanel({
  active,
  onActiveChange,
  builtIns = [],
  builtInContent,
  items,
  footer,
}: ProjectPanelProps) {
  const available = [
    ...builtIns.map((view) => view.id),
    ...items.map((item) => item.id),
  ];
  const [held, setOrder] = useState<readonly string[]>(available);
  const order = panelOrder(held, available);
  const item = items.find((entry) => entry.id === active);
  const builtIn = builtIns.some((view) => view.id === active);

  return (
    <Sidebar collapsible="none" className="overflow-hidden">
      <PanelHeader>
        <div className="ml-auto flex min-w-0 items-center gap-1 pr-2">
          <Tabs
            className="min-w-0 [app-region:no-drag]"
            value={active}
            onValueChange={onActiveChange}
          >
            <TabStrip
              label="Project views"
              selected={active}
              onMove={(from, to) => setOrder(movedPanelOrder(order, from, to))}
              items={order.flatMap((id) => {
                const view = builtIns.find((entry) => entry.id === id);
                if (view !== undefined) {
                  return [
                    {
                      id,
                      label: view.label,
                      icon: view.icon,
                      iconOnly: true,
                      badge: view.badge,
                    },
                  ];
                }
                const entry = items.find((candidate) => candidate.id === id);
                if (entry === undefined) return [];
                const badgeTag = entry.props?.badgeTag;
                return [
                  {
                    id,
                    label: text(entry.props?.label),
                    icon: panelIcon(entry.props?.icon),
                    iconOnly: true,
                    badge:
                      typeof badgeTag === 'string' && badgeTag !== '' ? (
                        <ElementHost tag={badgeTag} />
                      ) : undefined,
                  },
                ];
              })}
            />
          </Tabs>
          <Region name="layout.panel.header" />
        </div>
      </PanelHeader>
      <SidebarContent className="overflow-hidden p-0">
        <SidebarGroup className="h-full min-h-0 p-0">
          <SidebarGroupContent className="flex min-h-0 w-full flex-1 flex-col">
            {builtIn
              ? builtInContent
              : item !== undefined && (
                  <ElementHost
                    key={item.id}
                    tag={item.tag}
                    {...(item.props === undefined ? {} : { props: item.props })}
                  />
                )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <footer
        data-slot="project-files-footer"
        className="flex chrome-bar shrink-0 items-center gap-1 border-t bg-sidebar px-2 text-xs"
      >
        {footer}
        <Region name="layout.panel.footer" />
      </footer>
    </Sidebar>
  );
}

/**
 * The panel's header strip: the drag region, its boundary, and the controls it
 * carries — the view tabs and the panel's own toggle, together at the right
 * corner.
 */
function PanelHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div
      data-slot="project-files-header"
      className="relative flex chrome-bar shrink-0 items-center bg-sidebar pl-2 [app-region:drag]"
    >
      <Separator className="pointer-events-none absolute inset-x-0 bottom-0 [app-region:no-drag]" />
      {children}
    </div>
  );
}
