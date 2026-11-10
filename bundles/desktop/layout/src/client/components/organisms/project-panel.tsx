// The Project panel's content and its compact controls. The controls live in
// the Files column header; the panel itself starts directly with its content.

import type { RegionEntry } from 'bundle/contracts';
import { TabStrip } from 'desktop/ui/panels';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from 'desktop/ui/sidebar';
import { FileDiffIcon, FileIcon, FilesIcon, TerminalIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

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

type ProjectPanelProps = {
  readonly active: string;
  readonly builtIns?: readonly PanelBuiltIn[];
  /** What a built-in view shows; drawn while one is selected. */
  readonly builtInContent?: ReactNode;
  /** The `layout.panel` region items. */
  readonly items: readonly RegionEntry[];
};

/** Compact, reorderable view controls for the Files column header. */
export function ProjectPanelTabs({
  active,
  onActiveChange,
  builtIns = [],
  items,
}: Pick<ProjectPanelProps, 'active' | 'builtIns' | 'items'> & {
  readonly onActiveChange: (id: string) => void;
}) {
  const available = [
    ...builtIns.map((view) => view.id),
    ...items.map((item) => item.id),
  ];
  const [held, setOrder] = useState<readonly string[]>(available);
  const order = panelOrder(held, available);
  return (
    // One joined segmented group (Figma `266:21741` "Panel tabs"): no gap,
    // 28 px tabs with 6 px side padding, the 6 px radius on the group's outer
    // corners only, and `--accent` behind the selected view.
    <div className="min-w-0 flex-1 [-webkit-app-region:no-drag] [&_[data-tab-id]]:h-7 [&_[data-tab-id]]:px-1.5 [&_[data-tab-id]:not(:first-child)]:rounded-l-none [&_[data-tab-id]:not(:last-child)]:rounded-r-none [&_[data-tab-id][aria-pressed=true]]:bg-accent [&_[role=group]]:gap-0">
      <TabStrip
        variant="toggle"
        label="Project views"
        selected={active}
        onSelect={onActiveChange}
        onMove={(from, to) => setOrder(movedPanelOrder(order, from, to))}
        items={order.flatMap((id) => {
          const view = builtIns.find((entry) => entry.id === id);
          if (view !== undefined) {
            return [
              {
                id,
                label: view.label,
                iconOnly: true,
                icon: view.icon,
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
              iconOnly: true,
              icon: panelIcon(entry.props?.icon),
              badge:
                typeof badgeTag === 'string' && badgeTag !== '' ? (
                  <ElementHost tag={badgeTag} />
                ) : undefined,
            },
          ];
        })}
      />
    </div>
  );
}

/** The selected sandbox view, without a second header below the tab bar. */
export function ProjectPanel({
  active,
  builtIns = [],
  builtInContent,
  items,
}: ProjectPanelProps) {
  const item = items.find((entry) => entry.id === active);
  const builtIn = builtIns.some((view) => view.id === active);

  return (
    <Sidebar collapsible="none" className="overflow-hidden bg-transparent">
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
    </Sidebar>
  );
}
