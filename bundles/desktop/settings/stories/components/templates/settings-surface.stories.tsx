import { SidebarProvider } from 'desktop/ui/sidebar';
import type { ComponentType, CSSProperties } from 'react';

import {
  SettingsBreadcrumb,
  SettingsSurface,
} from '../../../src/client/components/templates/settings-surface.js';
import { controlFrame, windowFrame } from '../../support/frames.js';
import {
  NavSaveState,
  RevisionFooter,
  SectionHeading,
  type SectionId,
  useNav,
} from '../../support/window-parts.js';

/**
 * The surface needs the sidebar provider its frame owns, at the width the
 * settings window sets, so the stories give it one.
 */
const withSidebar = (Story: ComponentType) => (
  <SidebarProvider
    className="h-full min-h-0"
    style={{ '--sidebar-width': '240px' } as CSSProperties}
  >
    <Story />
  </SidebarProvider>
);

/** More rows than a window holds. */
const longRows = Array.from(
  { length: 40 },
  (_, index) => `Row ${index + 1}: the content scrolls under a fixed footer.`,
);

/** A surface whose section is taller than the window, so it scrolls. */
function LongSurface() {
  const nav = useNav();

  return (
    <SettingsSurface
      footer={<RevisionFooter />}
      nav={nav.nav}
      navEmpty={nav.empty}
      onQueryChange={nav.setQuery}
      query={nav.query}
      sidebarFooter={<NavSaveState />}
    >
      <SectionHeading id={nav.active} />
      {longRows.map((row) => (
        <p key={row} className="py-2 text-sm">
          {row}
        </p>
      ))}
    </SettingsSurface>
  );
}

/** The surface with its nav state, its footers and a section's placeholder. */
function Surface({
  initial,
  query,
  saving = false,
}: {
  readonly initial?: SectionId;
  readonly query?: string;
  readonly saving?: boolean;
}) {
  const nav = useNav(initial, query);
  const state = saving ? 'Saving…' : 'Saved';

  return (
    <SettingsSurface
      footer={<RevisionFooter text={state} />}
      nav={nav.nav}
      navEmpty={nav.empty}
      onQueryChange={nav.setQuery}
      query={nav.query}
      sidebarFooter={<NavSaveState text={state} />}
    >
      <SectionHeading id={nav.active} />
      <p className="text-sm text-muted-foreground">{nav.current.description}</p>
    </SettingsSurface>
  );
}

export default {
  title: 'Settings/Templates/Settings surface',
  component: SettingsSurface,
};

/** The window-sized frame every surface story is drawn in. */
const surfaceFrame = [withSidebar, windowFrame];

export const Default = {
  decorators: surfaceFrame,
  render: () => <Surface />,
};

export const Searching = {
  decorators: surfaceFrame,
  render: () => <Surface query="turns" initial="execution" />,
};

export const NoSectionMatches = {
  decorators: surfaceFrame,
  render: () => <Surface query="billing" />,
};

export const Saving = {
  decorators: surfaceFrame,
  render: () => <Surface initial="tools" saving />,
};

export const LongContent = {
  decorators: surfaceFrame,
  render: () => <LongSurface />,
};

export const Breadcrumb = {
  decorators: [controlFrame],
  render: () => (
    <SettingsBreadcrumb
      trail={[
        { label: 'Settings' },
        { label: 'Providers', onSelect: () => {} },
        { label: 'openrouter' },
      ]}
    />
  ),
};

export const BreadcrumbSection = {
  decorators: [controlFrame],
  render: () => (
    <SettingsBreadcrumb
      trail={[{ label: 'Settings' }, { label: 'Execution' }]}
    />
  ),
};
