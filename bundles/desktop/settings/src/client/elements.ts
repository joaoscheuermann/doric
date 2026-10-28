// The settings bundle's elements (design §6.2-§6.3). `<settings-page>` owns the
// one React root of the settings window; `<settings-link>` (a
// `settings.sections` region item) and the five section elements (the child
// routes of `/settings`) are portal hosts that root renders into, so the nav,
// the sections and the provider page share one draft and one save.

import { portalHosts } from 'desktop/ui/react-element';

/** The props of a `settings-link` region item (D9-15). */
export interface SettingsLinkProps {
  readonly label: string;
  readonly path: string;
  readonly icon?: string;
  readonly description?: string;
}

export const linkHosts = portalHosts<SettingsLinkProps>([
  'label',
  'path',
  'icon',
  'description',
]);

export const sectionIds = [
  'profile',
  'providers',
  'execution',
  'tools',
  'credentials',
] as const;

export type SectionId = (typeof sectionIds)[number];

export const sectionHosts = {
  profile: portalHosts<Record<string, never>>([]),
  providers: portalHosts<Record<string, never>>([]),
  execution: portalHosts<Record<string, never>>([]),
  tools: portalHosts<Record<string, never>>([]),
  credentials: portalHosts<Record<string, never>>([]),
} as const satisfies Record<SectionId, unknown>;

/** The `layout.dashboard.page` item id of the dashboard's provider page. */
export const PROVIDER_PAGE_ID = 'settings.provider';

/**
 * `<settings-dashboard-provider>`, the dashboard page the Providers group's
 * root (`<settings-dashboard-providers>`) renders the open provider into, so
 * the group's rows and the page share one draft and one save.
 */
export const providerPageHosts = portalHosts<Record<string, never>>([]);
