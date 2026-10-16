import { Badge } from 'desktop/ui/badge';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarScope,
  SidebarSeparator,
  SidebarTrigger,
} from 'desktop/ui/sidebar';
import {
  ChevronsUpDownIcon,
  CircleDotIcon,
  FolderIcon,
  LoaderIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import { projects, type ThreadFixture, threads } from '../support/doric.js';

export default {
  title: 'desktop/ui/Sidebar',
  component: Sidebar,
};

/*
 * The shared sidebar positions itself against the window (`fixed`, `h-svh`).
 * A story frames it instead: a positioned box the height of a short window,
 * and the collapsible sidebars take `absolute h-full` so they stay inside it.
 */
const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div className="relative h-[34rem] overflow-hidden rounded-lg border">
    {children}
  </div>
);

const statusIcon = (status: ThreadFixture['status']) =>
  status === 'running' ? (
    <LoaderIcon className="animate-spin" />
  ) : status === 'awaiting' ? (
    <CircleDotIcon className="text-orange-500" />
  ) : (
    <MessageSquareIcon />
  );

const ProjectSwitcher = () => (
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton size="lg" tooltip="doric">
        <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          D
        </div>
        <div className="grid flex-1 text-left leading-tight">
          <span className="truncate font-medium">doric</span>
          <span className="truncate text-xs text-muted-foreground">
            feat/app
          </span>
        </div>
        <ChevronsUpDownIcon className="ml-auto" />
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>
);

const ProjectsGroup = () => (
  <SidebarGroup>
    <SidebarGroupLabel>Projects</SidebarGroupLabel>
    <SidebarGroupAction title="Add project">
      <PlusIcon />
      <span className="sr-only">Add project</span>
    </SidebarGroupAction>
    <SidebarGroupContent>
      <SidebarMenu>
        {projects.map((project, index) => (
          <SidebarMenuItem key={project.id}>
            <SidebarMenuButton isActive={index === 0} tooltip={project.name}>
              <FolderIcon />
              <span>{project.name}</span>
            </SidebarMenuButton>
            {index === 0 && <SidebarMenuBadge>3</SidebarMenuBadge>}
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroupContent>
  </SidebarGroup>
);

const ThreadsGroup = () => (
  <SidebarGroup>
    <SidebarGroupLabel>Threads</SidebarGroupLabel>
    <SidebarGroupAction title="New thread">
      <PlusIcon />
      <span className="sr-only">New thread</span>
    </SidebarGroupAction>
    <SidebarGroupContent>
      <SidebarMenu>
        {threads.map((thread, index) => (
          <SidebarMenuItem key={thread.id}>
            <SidebarMenuButton isActive={index === 0} tooltip={thread.title}>
              {statusIcon(thread.status)}
              <span>{thread.title}</span>
            </SidebarMenuButton>
            <SidebarMenuAction showOnHover>
              <MoreHorizontalIcon />
              <span className="sr-only">Thread actions</span>
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroupContent>
  </SidebarGroup>
);

const Footer = () => (
  <SidebarFooter>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton tooltip="Settings">
          <SettingsIcon />
          <span>Settings</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarFooter>
);

const Conversation = () => (
  <SidebarInset>
    <header className="flex h-10 items-center gap-2 border-b px-2">
      <SidebarTrigger />
      <span className="truncate text-sm font-medium">
        Add comment threads to papercraft previews
      </span>
    </header>
    <div className="flex-1 p-4 text-sm text-muted-foreground">
      The Thread's conversation draws here.
    </div>
  </SidebarInset>
);

export const Workspace = {
  render: () => (
    <Frame>
      <SidebarProvider className="h-full min-h-0">
        <Sidebar collapsible="none" className="border-r">
          <SidebarHeader>
            <ProjectSwitcher />
            <SidebarInput placeholder="Search threads" />
          </SidebarHeader>
          <SidebarContent>
            <ProjectsGroup />
            <SidebarSeparator />
            <ThreadsGroup />
          </SidebarContent>
          <Footer />
        </Sidebar>
        <Conversation />
      </SidebarProvider>
    </Frame>
  ),
};

const CollapsibleSidebar = ({
  open,
  variant = 'sidebar',
}: {
  readonly open: boolean;
  readonly variant?: 'sidebar' | 'floating' | 'inset';
}) => (
  <Frame>
    <SidebarProvider defaultOpen={open} className="h-full min-h-0">
      <Sidebar collapsible="icon" variant={variant} className="absolute h-full">
        <SidebarHeader>
          <ProjectSwitcher />
        </SidebarHeader>
        <SidebarContent>
          <ProjectsGroup />
          <ThreadsGroup />
        </SidebarContent>
        <Footer />
        <SidebarRail />
      </Sidebar>
      <Conversation />
    </SidebarProvider>
  </Frame>
);

export const Expanded = {
  render: () => <CollapsibleSidebar open />,
};

export const IconCollapsed = {
  render: () => <CollapsibleSidebar open={false} />,
};

export const Floating = {
  render: () => <CollapsibleSidebar open variant="floating" />,
};

export const Inset = {
  render: () => <CollapsibleSidebar open variant="inset" />,
};

export const NestedMenu = {
  render: () => (
    <Frame>
      <SidebarProvider className="h-full min-h-0">
        <Sidebar collapsible="none" className="border-r">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Projects</SidebarGroupLabel>
              <SidebarMenu>
                {projects.slice(0, 2).map((project, index) => (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton>
                      <FolderIcon />
                      <span>{project.name}</span>
                    </SidebarMenuButton>
                    <SidebarMenuSub>
                      {threads.slice(index, index + 3).map((thread, row) => (
                        <SidebarMenuSubItem key={thread.id}>
                          <SidebarMenuSubButton
                            href={`#${thread.id}`}
                            isActive={index === 0 && row === 0}
                          >
                            <span>{thread.title}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton href="#more" size="sm">
                          <span>Show 4 more</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </Frame>
  ),
};

export const MenuButtonSizes = {
  render: () => (
    <Frame>
      <SidebarProvider className="h-full min-h-0">
        <Sidebar collapsible="none" className="border-r">
          <SidebarContent>
            <SidebarGroup>
              <SidebarMenu>
                {(['sm', 'default', 'lg'] as const).map((size) => (
                  <SidebarMenuItem key={size}>
                    <SidebarMenuButton size={size}>
                      <MessageSquareIcon />
                      <span>Size {size}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
                <SidebarMenuItem>
                  <SidebarMenuButton variant="outline">
                    <MessageSquareIcon />
                    <span>Outline</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton disabled>
                    <MessageSquareIcon />
                    <span>Disabled</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive>
                    <MessageSquareIcon />
                    <span>Active</span>
                  </SidebarMenuButton>
                  <SidebarMenuBadge>
                    <Badge variant="secondary">12</Badge>
                  </SidebarMenuBadge>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </Frame>
  ),
};

export const Loading = {
  render: () => (
    <Frame>
      <SidebarProvider className="h-full min-h-0">
        <Sidebar collapsible="none" className="border-r">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Threads</SidebarGroupLabel>
              <SidebarMenu>
                {['a', 'b', 'c', 'd', 'e'].map((row) => (
                  <SidebarMenuItem key={row}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    </Frame>
  ),
};

/*
 * `SidebarScope` lets a bundle element draw sidebar rows in its own React
 * root, outside any `SidebarProvider`.
 */
export const Scope = {
  decorators: [
    (Story: ComponentType) => (
      <div className="w-64 rounded-lg border bg-sidebar p-2 text-sidebar-foreground">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <SidebarScope>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton>
            <TerminalIcon />
            <span>zsh — doric</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton isActive>
            <TerminalIcon />
            <span>npm run dev</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarScope>
  ),
};
