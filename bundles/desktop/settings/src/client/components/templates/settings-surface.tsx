import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from 'desktop/ui/breadcrumb';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
} from 'desktop/ui/sidebar';
import type { LucideIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

/** One section the shell offers, named by the caller that owns the sections. */
export type SettingsNavItem = {
  /**
   * The sentence the nav searches beside the label, so a reader finds a section
   * by what it explains rather than by the one word it is named after. It is not
   * drawn: a section's heading shows the label alone.
   */
  readonly description?: string;
  readonly icon: LucideIcon;
  readonly id: string;
  readonly label: string;
};

export type SettingsSurfaceProps = {
  readonly children: ReactNode;
  /** The facts and actions under the scrolling content; the caller owns them. */
  readonly footer: ReactNode;
  /**
   * The nav's rows: the `settings.sections` region, whose items the caller
   * draws already searched. It stays mounted while a query hides every row, so
   * the region's items survive the query.
   */
  readonly nav: ReactNode;
  /** Whether the query left no row to show. */
  readonly navEmpty: boolean;
  readonly onQueryChange: (query: string) => void;
  /**
   * What the nav's search field holds. Which sections match it is decided above,
   * because that is a rule about the sections rather than an arrangement.
   */
  readonly query: string;
  /** The facts under the nav; the caller owns them, as it does the content's. */
  readonly sidebarFooter: ReactNode;
};

/**
 * One part of the chain a settings frame names what it is showing with. Every
 * part but the last leads somewhere — the surface itself does not, and the page
 * on screen is where the chain already is.
 */
export type SettingsCrumb = {
  readonly label: string;
  /** Selects what the crumb names; absent when the part leads nowhere. */
  readonly onSelect?: () => void;
};

/**
 * The chain naming the settings surface and the page it is showing, outermost
 * first. Every part but the last is a control that leads back to it, so a window
 * that draws this in its chrome doubles as the way out of a nested page.
 */
export function SettingsBreadcrumb({
  trail,
}: {
  readonly trail: readonly SettingsCrumb[];
}) {
  return (
    <Breadcrumb className="min-w-0 [app-region:no-drag]">
      <BreadcrumbList className="flex-nowrap">
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <Fragment key={crumb.label}>
              {index > 0 && <BreadcrumbSeparator className="shrink-0" />}
              <BreadcrumbItem className={last ? 'min-w-0' : 'shrink-0'}>
                {last || crumb.onSelect === undefined ? (
                  <BreadcrumbPage className="truncate">
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    render={<button type="button" onClick={crumb.onSelect} />}
                  >
                    {crumb.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The arrangement every settings frame shares: a fixed nav beside the section
 * being edited, a footer under each of them, and a search field over the nav.
 * Nothing here knows which sections exist, what they configure, or what the
 * footers carry, so a frame can add its own header without this knowing what
 * went into it. A frame owns that header, the canvas both columns sit on, and
 * the sidebar provider both columns are drawn at, because naming the active
 * section and the width of the window's grid are the frame's business.
 *
 * Nothing is divided by a rule (ui-redesign, Figma `36:22049`): the nav sits
 * on the frame's `--sidebar` canvas with no fill of its own, and the section
 * with its footer is an inset card on that canvas — the `--background` fill,
 * a 10px radius and the small shadow. The row both stand in keeps 8px of
 * canvas on its right and bottom (and on its left while the nav is hidden), so
 * the nav's footer and the card's footer end on the same line.
 */
export function SettingsSurface({
  children,
  footer,
  nav,
  navEmpty,
  onQueryChange,
  query,
  sidebarFooter,
}: SettingsSurfaceProps) {
  return (
    /*
      The two columns are drawn at the width the frame's sidebar provider sets,
      so a header above this can line its own cells up with them.
    */
    <div className="flex h-full min-h-0 items-start pr-2 pb-2 pl-2 md:pl-0">
      <Sidebar collapsible="none" className="hidden bg-transparent md:flex">
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
            {navEmpty && (
              <div className="flex chrome-bar items-center px-2 text-xs text-muted-foreground">
                No sections match
              </div>
            )}
            <SidebarMenu className="gap-1" hidden={navEmpty}>
              {nav}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        {/*
          The bottom of the nav column, at the height of the content's own footer
          band, so the two read as one strip across the window.
        */}
        <SidebarFooter className="chrome-bar shrink-0 justify-center">
          {sidebarFooter}
        </SidebarFooter>
      </Sidebar>
      {/*
        The card is what sets the section off from the nav: no line is drawn
        where the two meet.
      */}
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-background shadow-sm">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        <footer className="flex chrome-bar shrink-0 items-center px-4">
          {footer}
        </footer>
      </main>
    </div>
  );
}
