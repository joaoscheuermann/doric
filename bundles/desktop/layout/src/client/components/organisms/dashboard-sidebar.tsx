import type { RegionEntry } from 'bundle/contracts';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import {
  Sidebar,
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
  SidebarScope,
} from 'desktop/ui/sidebar';
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import type { Project } from '../../domain/workspace.js';
import { ElementHost } from '../molecules/element-host.js';
import { ProjectAvatar } from '../molecules/project-avatar.js';

/**
 * The /projects dashboard's side menu: the search, "All projects", the
 * Projects group, the groups other bundles add to `layout.dashboard.nav`
 * (each draws its own `SidebarGroup`), and "All settings" at the foot. It
 * draws its own sidebar scope, since the dashboard has no `SidebarProvider`.
 */
export function DashboardSidebar({
  search,
  projects,
  listActive,
  navItems,
  onAllProjects,
  onNewProject,
  onSelectProject,
  onOpenSettings,
}: {
  readonly search: ReactNode;
  readonly projects: readonly Project[];
  readonly listActive: boolean;
  readonly navItems: readonly RegionEntry[];
  readonly onAllProjects: () => void;
  readonly onNewProject: () => void;
  readonly onSelectProject: (project: Project) => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  return (
    <SidebarScope>
      <Sidebar
        collapsible="none"
        className="h-full w-[240px] shrink-0 font-normal"
      >
        <SidebarHeader>{search}</SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={listActive}
                  onClick={onAllProjects}
                  className="data-active:font-normal"
                >
                  <FolderIcon />
                  <span>All projects</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
          <Collapsible defaultOpen className="group/collapsible">
            <SidebarGroup>
              <SidebarGroupLabel
                render={<CollapsibleTrigger />}
                className="gap-1 pl-1.5 font-normal"
              >
                <ChevronRightIcon className="transition-transform group-data-[open]/collapsible:rotate-90" />
                Projects
              </SidebarGroupLabel>
              <SidebarGroupAction
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
                          onClick={() => onSelectProject(project)}
                        >
                          <ProjectAvatar
                            color={project.color}
                            className="size-3"
                          />
                          <span className="min-w-0 flex-1 truncate font-light">
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
            <ElementHost key={`${item.owner}:${item.id}`} tag={item.tag} />
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onOpenSettings}>
                <SettingsIcon />
                <span>All settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
    </SidebarScope>
  );
}
