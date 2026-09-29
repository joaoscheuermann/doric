import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** One section the shell offers, named by the caller that owns the sections. */
export type SettingsNavItem = {
  readonly icon: LucideIcon;
  readonly id: string;
  readonly label: string;
};

export type SettingsSurfaceProps = {
  /** The id of the nav item whose section is showing. */
  readonly activeId: string;
  readonly children: ReactNode;
  /** The facts and actions under the scrolling content; the caller owns them. */
  readonly footer: ReactNode;
  readonly nav: readonly SettingsNavItem[];
  readonly onSelect: (id: string) => void;
};

/**
 * The chain naming the settings surface and the section it is showing. It is a
 * molecule so a frame that draws a header of its own can put it in that header:
 * the section a window is on belongs to the window's chrome, not to the section.
 */
export function SettingsBreadcrumb({ title }: { readonly title: string }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="shrink-0">Settings</BreadcrumbItem>
        <BreadcrumbSeparator className="shrink-0" />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The arrangement every settings frame shares: a fixed nav beside the section
 * being edited, and a footer for whatever the caller puts there. Nothing here
 * knows which sections exist, what they configure, or what the footer carries,
 * so a frame can add its own header without this knowing what went into it. A
 * frame owns that header and the divider above this, because naming the active
 * section is the frame's business.
 */
export function SettingsSurface({
  activeId,
  children,
  footer,
  nav,
  onSelect,
}: SettingsSurfaceProps) {
  return (
    <SidebarProvider className="h-full min-h-0 items-start">
      <Sidebar collapsible="none" className="hidden md:flex">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {nav.map((section) => {
                const Icon = section.icon;
                return (
                  <SidebarMenuItem key={section.id}>
                    <SidebarMenuButton
                      isActive={section.id === activeId}
                      onClick={() => onSelect(section.id)}
                    >
                      <Icon />
                      <span>{section.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      {/*
        The nav is a fixed-position container, so it draws no border of its own
        where it meets the section; a vertical separator in the flex row is what
        divides the two, stretching to the full height of the surface.
      */}
      <Separator orientation="vertical" />
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        <div className="flex h-8 shrink-0 items-center border-t px-4">
          {footer}
        </div>
      </main>
    </SidebarProvider>
  );
}
