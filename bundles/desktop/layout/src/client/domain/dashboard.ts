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
 * The search shortcut's hint as the home body's "Search projects" field draws
 * it, as one text: `'⌘F'` when `platform` names an Apple platform (Mac,
 * iPhone, iPad), `'Ctrl+F'` otherwise. Pure; never throws.
 */
export const searchShortcutLabel = (platform: string): '⌘F' | 'Ctrl+F' =>
  /Mac|iPhone|iPad/.test(platform) ? '⌘F' : 'Ctrl+F';

/**
 * The search shortcut as the Dashboard sidebar's "Search projects" field draws
 * it, one key per entry (Figma `34:12218`): `['⌘', 'F']` on an Apple platform,
 * `['Ctrl', 'F']` otherwise. Pure; never throws.
 */
export const searchShortcutKeys = (
  platform: string,
): readonly ['⌘' | 'Ctrl', 'F'] =>
  /Mac|iPhone|iPad/.test(platform) ? ['⌘', 'F'] : ['Ctrl', 'F'];
