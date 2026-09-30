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
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** One section the shell offers, named by the caller that owns the sections. */
export type SettingsNavItem = {
  /**
   * The sentence the section shows above its controls. The nav searches it as
   * well as the label, so a reader finds a section by what it explains rather
   * than by the one word it is named after.
   */
  readonly description?: string;
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
  /** The sections the nav lists, in the order it lists them, already searched. */
  readonly nav: readonly SettingsNavItem[];
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (id: string) => void;
  /**
   * What the nav's search field holds. Which sections match it is decided above,
   * because that is a rule about the sections rather than an arrangement.
   */
  readonly query: string;
  /** The facts under the nav; the caller owns them, as it does the content's. */
  readonly sidebarFooter: ReactNode;
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
 * being edited, a footer under each of them, and a search field over the nav.
 * Nothing here knows which sections exist, what they configure, or what the
 * footers carry, so a frame can add its own header without this knowing what
 * went into it. A frame owns that header, the divider above this, and the
 * sidebar provider both columns are drawn at, because naming the active section
 * and the width of the window's grid are the frame's business.
 */
export function SettingsSurface({
  activeId,
  children,
  footer,
  nav,
  onQueryChange,
  onSelect,
  query,
  sidebarFooter,
}: SettingsSurfaceProps) {
  return (
    /*
      The two columns and the separator between them are drawn at the width the
      frame's sidebar provider sets, so a header above this can put its own
      divider on the same boundary.
    */
    <div className="flex h-full min-h-0 items-start">
      <Sidebar collapsible="none" className="hidden md:flex">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Settings</SidebarGroupLabel>
            <SidebarInput
              aria-label="Search settings sections"
              className="mb-1"
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search"
              type="search"
              value={query}
            />
            {nav.length === 0 ? (
              <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
                No sections match
              </div>
            ) : (
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
            )}
          </SidebarGroup>
        </SidebarContent>
        {/*
          The bottom of the nav column, at the height of the content's own footer
          band, so the two read as one strip across the window.
        */}
        <SidebarFooter className="h-8 shrink-0 justify-center border-t">
          {sidebarFooter}
        </SidebarFooter>
      </Sidebar>
      {/*
        The nav is a fixed-position container, so it draws no border of its own
        where it meets the section; a vertical separator in the flex row is what
        divides the two, stretching to the full height of the surface. It is
        drawn only while the nav column is, so a window too narrow for a nav
        does not wear a line down its own edge.
      */}
      <Separator orientation="vertical" className="hidden md:block" />
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        <div className="flex h-8 shrink-0 items-center border-t px-4">
          {footer}
        </div>
      </main>
    </div>
  );
}
