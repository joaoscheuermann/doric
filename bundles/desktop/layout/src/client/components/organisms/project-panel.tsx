// The Project panel's content and its compact controls. The controls live in
// the workspace tab bar; the panel itself starts directly with its content.

import type { RegionEntry } from 'bundle/contracts';
import { TabStrip } from 'desktop/ui/panels';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
} from 'desktop/ui/sidebar';
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
  readonly builtIns?: readonly PanelBuiltIn[];
  /** What a built-in view shows; drawn while one is selected. */
  readonly builtInContent?: ReactNode;
  /** The `layout.panel` region items. */
  readonly items: readonly RegionEntry[];
  /** The footer's built-in content, before the `layout.panel.footer` region. */
  readonly footer?: ReactNode;
};

/** Compact, reorderable view controls for the workspace's top tab bar. */
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
    <div className="min-w-0 max-w-[40vw] [-webkit-app-region:no-drag]">
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
  footer,
}: ProjectPanelProps) {
  const item = items.find((entry) => entry.id === active);
  const builtIn = builtIns.some((view) => view.id === active);

  return (
    <Sidebar collapsible="none" className="overflow-hidden">
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
