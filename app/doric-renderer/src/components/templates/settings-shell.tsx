import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
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

type SettingsShellProps = {
  /** The id of the nav item whose section is showing. */
  readonly activeId: string;
  readonly children: ReactNode;
  /** The facts and actions under the scrolling content; the caller owns them. */
  readonly footer: ReactNode;
  readonly nav: readonly SettingsNavItem[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (id: string) => void;
  readonly open: boolean;
  /** The active section's name, which the breadcrumb ends on. */
  readonly title: string;
};

/**
 * The settings frame: a dialog holding a fixed nav, a breadcrumb over one
 * section, and a footer for whatever the caller puts there. Nothing here knows
 * which sections exist, what they configure, or what the footer carries.
 */
export function SettingsShell({
  activeId,
  children,
  footer,
  nav,
  onOpenChange,
  onSelect,
  open,
  title,
}: SettingsShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[36rem] max-h-[85vh] overflow-hidden p-0 sm:max-w-3xl">
        <DialogTitle className="sr-only">{title} settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure how Doric runs prompts. Changes are saved to the host.
        </DialogDescription>
        <SidebarProvider className="items-start">
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
          <main className="flex h-[36rem] max-h-[85vh] flex-1 flex-col overflow-hidden">
            {/* The dialog's own close button sits over the header's right edge. */}
            <header className="flex h-12 shrink-0 items-center gap-2 border-b pr-10 pl-4">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>Settings</BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>{title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
            <div className="flex h-8 shrink-0 items-center border-t px-4">
              {footer}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
