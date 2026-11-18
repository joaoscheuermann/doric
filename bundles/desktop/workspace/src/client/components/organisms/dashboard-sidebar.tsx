import {
  CommandsV1,
  isContractId,
  type RegionEntry,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import { ElementHost } from 'desktop/ui/element-host';
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from 'desktop/ui/sidebar';
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
} from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import type { Project } from '../../domain/workspace.js';
import {
  type FooterEntry,
  useFooterItems,
} from '../../hooks/use-footer-items.js';
import { workspaceServices } from '../../services/workspace-services.js';
import { ProjectAvatar } from '../molecules/project-avatar.js';

/** A 28 px sidebar row: 6 px padding and gap, 13 px regular text (`85:7520`). */
const row =
  'h-7 gap-1.5 px-1.5 py-0 text-[13px] font-normal data-active:font-normal';

/**
 * The /projects dashboard's side menu: the sidebar header (the Dashboard
 * button) above the search, the search, "All projects", the Projects group
 * and the groups other bundles add to `workspace.dashboard.nav` (each draws its
 * own `SidebarGroup`). The page form's sidebar column draws it inside its
 * `<Sidebar>`, then the notice and `DashboardSidebarFooter`; the caller
 * provides the sidebar scope.
 */
export function DashboardSidebar({
  header,
  search,
  projects,
  listActive,
  navItems,
  onAllProjects,
  onNewProject,
  onSelectProject,
}: {
  /**
   * The sidebar's 40 px header: the `SidebarHeader` organism (macOS inset,
   * then the "Dashboard" button). It is drawn first, above the search,
   * outside the scrolling content. Required: the Dashboard sidebar always
   * starts at the window's left edge.
   */
  readonly header: ReactNode;
  readonly search: ReactNode;
  readonly projects: readonly Project[];
  readonly listActive: boolean;
  readonly navItems: readonly RegionEntry[];
  readonly onAllProjects: () => void;
  readonly onNewProject: () => void;
  readonly onSelectProject: (project: Project) => void;
}): JSX.Element {
  return (
    <>
      {header}
      {/* Prototype density (`85:7520`, DashboardSidebar): 6 px side inset,
          the search directly under the header, 12 px between the search
          and each group, 28 px rows with 13 px regular names. */}
      <SidebarHeader className="px-1.5 py-0">{search}</SidebarHeader>
      <SidebarContent className="gap-3 px-1.5 pt-3">
        <SidebarGroup className="p-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={listActive}
                onClick={onAllProjects}
                className={row}
              >
                <FolderIcon />
                <span>All projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <Collapsible defaultOpen className="group/collapsible">
          <SidebarGroup className="gap-1 p-0">
            <SidebarGroupLabel
              render={<CollapsibleTrigger />}
              className="h-5 gap-1 pl-1.5 font-normal"
            >
              <ChevronRightIcon className="transition-transform group-data-[open]/collapsible:rotate-90" />
              Projects
            </SidebarGroupLabel>
            <SidebarGroupAction
              className="top-0 right-1"
              title="New project"
              aria-label="New project"
              onClick={onNewProject}
            >
              <PlusIcon />
            </SidebarGroupAction>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {projects.map((project) => (
                    <SidebarMenuItem key={project.id}>
                      <SidebarMenuButton
                        className={row}
                        onClick={() => onSelectProject(project)}
                      >
                        <ProjectAvatar
                          color={project.color}
                          className="size-4"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {project.name}
                        </span>
                        <ArrowUpRightIcon className="text-sidebar-foreground/60 opacity-0 group-hover/menu-button:opacity-100 group-focus-visible/menu-button:opacity-100" />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
        {navItems.map((item) => (
          <ElementHost
            ui={workspaceServices().use(UiV1)}
            key={`${item.owner}:${item.id}`}
            tag={item.tag}
          />
        ))}
      </SidebarContent>
    </>
  );
}

/**
 * The page form's `shell.sidebar.footer` item (`85:7520`): one button per
 * drawable `workspace.dashboard.footer` item, its `tag` element as the 16 px
 * icon, then its label, which is also its accessible name; a pick executes the item's command with its input
 * through `commands/v1`. With no drawable item it draws nothing (decision O6).
 */
export function DashboardSidebarFooter(): JSX.Element | null {
  const services = workspaceServices();
  const entries = useFooterItems(services.use(RegionsV1));
  if (entries.length === 0) return null;
  const pick = ({ props }: FooterEntry): void => {
    const { command, input } = props;
    if (!isContractId(command)) return;
    void services
      .use(CommandsV1)
      .execute(command, input)
      .catch((error: unknown) => {
        console.error(`Doric: the command ${command} could not run:`, error);
      });
  };
  return (
    <SidebarFooter>
      <SidebarMenu>
        {entries.map((entry) => (
          <SidebarMenuItem key={entry.id}>
            <SidebarMenuButton
              aria-label={entry.props.label}
              onClick={() => pick(entry)}
            >
              <ElementHost ui={services.use(UiV1)} tag={entry.tag} />
              <span>{entry.props.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarFooter>
  );
}
