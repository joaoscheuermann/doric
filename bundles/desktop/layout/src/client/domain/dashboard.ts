import type { RegionEntry } from 'bundle/contracts';

/**
 * The `layout.dashboard.page` entry the /projects dashboard draws instead of
 * the project list: the one whose id is the active page. None while no page is
 * active or while no entry has that id, so the list draws.
 */
export const dashboardPage = (
  items: readonly RegionEntry[],
  active: string | undefined,
): RegionEntry | undefined =>
  active === undefined ? undefined : items.find((item) => item.id === active);

/** The keys of the dashboard search's shortcut, as the platform names them. */
export const searchShortcutKeys = (
  platform: string,
): readonly [string, string] =>
  /Mac|iPhone|iPad/.test(platform) ? ['⌘', 'F'] : ['Ctrl', 'F'];
