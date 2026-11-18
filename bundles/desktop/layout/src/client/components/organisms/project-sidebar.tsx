import { UiV1 } from 'bundle/contracts';
import { ElementHost } from 'desktop/ui/element-host';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
} from 'desktop/ui/sidebar';
import { cn } from 'desktop/ui/utils';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { StackPane } from '../../../contracts/index.js';
import { usePaneOpen, useStackPanes } from '../../hooks/use-stack-panes.js';
import { layoutServices } from '../../services/layout-services.js';
import { togglePane } from '../../stores/stack.js';
import { BundleHealthNotice } from '../molecules/bundle-health-notice.js';

/**
 * One group of the sidebar's stack (`layout.stack/v2`): the pane's 28 px
 * header the layout draws — its title, its collapse control and its own action
 * element, shown while the header is hovered or holds focus — and, while open,
 * the pane's element. The group is as tall as its content, at most 40% of the
 * column, and never shorter than its header, so it cannot vanish; past the cap
 * its content scrolls.
 */
function StackPaneGroup({
  action,
  pane,
}: {
  readonly action?: ReactNode;
  readonly pane: StackPane;
}) {
  const open = usePaneOpen(pane.id);
  const collapsible = pane.collapsible !== false;

  return (
    <SidebarGroup
      data-slot="sidebar-pane"
      data-pane-id={pane.id}
      className="flex max-h-[40%] min-h-7 flex-col p-0"
    >
      <div className="group/pane-header relative shrink-0">
        <SidebarGroupLabel className="h-7 gap-1 rounded-none pl-3 pr-8 text-xs font-normal [&_svg]:size-4 [&_svg]:shrink-0">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} ${pane.title}`}
              className="flex min-w-0 flex-1 items-center gap-1 text-left outline-hidden focus-visible:ring-2"
              onClick={() => togglePane(pane.id)}
            >
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  'size-4 shrink-0 transition-transform duration-[50ms] ease-out',
                  open ? 'rotate-90' : 'rotate-0',
                )}
              />
              <span className="truncate">{pane.title}</span>
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate">{pane.title}</span>
          )}
        </SidebarGroupLabel>
        {action !== undefined && (
          <div className="pointer-events-none opacity-0 group-hover/pane-header:pointer-events-auto group-hover/pane-header:opacity-100 group-focus-within/pane-header:pointer-events-auto group-focus-within/pane-header:opacity-100">
            {action}
          </div>
        )}
      </div>
      {/* The rows sit 6 px in from the column edges (Figma `269:31402`:
          ProjectSidebar at x 6, 268 wide), so their 4 px rounded selection
          fill does not touch them. */}
      {open && (
        <SidebarGroupContent className="min-h-0 w-full flex-1 overflow-y-auto px-1.5">
          {pane.tag !== undefined && (
            <ElementHost
              ui={layoutServices().use(UiV1)}
              tag={pane.tag}
              {...(pane.props === undefined ? {} : { props: pane.props })}
            />
          )}
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}

const paneAction = (pane: StackPane): ReactNode =>
  pane.headerTag === undefined ? null : (
    <ElementHost ui={layoutServices().use(UiV1)} tag={pane.headerTag} />
  );

/**
 * The conversation form's sidebar column: `children` (the `shell.sidebar`
 * items, which draw `ProjectSidebar`), then one group per registered stack
 * pane (`layout.stack/v2`), the quarantine notice, and `footer` (the
 * `shell.sidebar.footer` items) last.
 */
export function ProjectSidebarColumn({
  children,
  footer,
}: {
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  const panes = useStackPanes();
  return (
    <Sidebar collapsible="none" className="overflow-hidden font-normal">
      {/* Not clipped: the search field's focus ring (3 px) reaches above the
          content's top edge, into the header's last 3 px. The Thread tree and
          the panes below bound their own overflow; 14 px below the last
          pane. */}
      <SidebarContent className="overflow-visible p-0 pb-3.5">
        {children}
        {panes.map((pane) => (
          <StackPaneGroup key={pane.id} action={paneAction(pane)} pane={pane} />
        ))}
        <BundleHealthNotice className="mx-1.5 shrink-0" />
        {footer}
      </SidebarContent>
    </Sidebar>
  );
}
