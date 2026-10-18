// The parts a settings frame is composed from, built the way the settings
// view builds them: the nav rows of this bundle's sections (searched by the
// view's own rule), the save state under the nav, and the revision footer.
// The templates draw these without the view, so their stories show the frame
// alone with the content each slot holds in the app.

import { SidebarMenuButton, SidebarMenuItem } from 'desktop/ui/sidebar';
import { useState } from 'react';

import { sectionIcon } from '../../src/client/components/molecules/section-icon.js';
import { updatedAtLabel } from '../../src/client/domain/config.js';
import { sections } from '../../src/client/domain/sections.js';
import { filterSettingsSections } from '../../src/client/domain/settings-search.js';

export type SectionId = (typeof sections)[number]['id'];

/** The nav state a frame story owns: the query and the active section. */
export const useNav = (initial: SectionId = 'providers', query = '') => {
  const [active, setActive] = useState<SectionId>(initial);
  const [search, setSearch] = useState(query);
  const matching = filterSettingsSections(sections, search);

  return {
    active,
    current: sections.find((section) => section.id === active) ?? sections[0],
    empty: matching.length === 0,
    query: search,
    setQuery: setSearch,
    nav: matching.map((section) => {
      const Icon = sectionIcon(section.icon);
      return (
        <SidebarMenuItem key={section.id}>
          <SidebarMenuButton
            isActive={section.id === active}
            onClick={() => setActive(section.id)}
          >
            {Icon !== undefined && <Icon />}
            <span>{section.label}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      );
    }),
  };
};

/** What the nav footer says: the save state alone. */
export function NavSaveState({
  destructive = false,
  text = 'Saved',
}: {
  readonly destructive?: boolean;
  readonly text?: string;
}) {
  return (
    <span
      className={
        destructive
          ? 'truncate text-xs text-destructive'
          : 'truncate text-xs text-muted-foreground'
      }
    >
      {text}
    </span>
  );
}

/** The content footer: the stored revision, then the save state. */
export function RevisionFooter({
  destructive = false,
  text = 'Saved',
}: {
  readonly destructive?: boolean;
  readonly text?: string;
}) {
  return (
    <div className="flex w-full items-center gap-2 text-xs text-muted-foreground">
      <span>
        Revision 42 · Updated {updatedAtLabel('2026-10-14T09:30:00.000Z')}
      </span>
      <span>·</span>
      <span className={destructive ? 'text-destructive' : ''}>{text}</span>
    </div>
  );
}

/**
 * A section heading as the view draws it: the section's icon, then its label,
 * or the title of the page open under the section.
 */
export function SectionHeading({
  id,
  title,
}: {
  readonly id: SectionId;
  readonly title?: string;
}) {
  const section = sections.find((entry) => entry.id === id) ?? sections[0];
  const Icon = sectionIcon(section.icon);

  return (
    <header className="mb-4 flex items-center gap-2">
      {Icon !== undefined && <Icon aria-hidden className="size-5 shrink-0" />}
      <h1 className="text-lg font-medium">{title ?? section.label}</h1>
    </header>
  );
}
