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

/**
 * The search shortcut's hint, as both "Search projects" fields draw it:
 * `'⌘F'` when `platform` names an Apple platform (Mac, iPhone, iPad),
 * `'Ctrl+F'` otherwise. Pure; never throws.
 */
export const searchShortcutLabel = (platform: string): '⌘F' | 'Ctrl+F' =>
  /Mac|iPhone|iPad/.test(platform) ? '⌘F' : 'Ctrl+F';
