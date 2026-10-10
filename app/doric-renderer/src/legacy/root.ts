/**
 * Which legacy root a window mounts. Every window loads the same shell, so the
 * path main opened it at is what tells the settings window from the workspace:
 * `/settings` and everything under it is the settings surface, every other path
 * is the workspace.
 */
export type LegacyRoot = 'workspace' | 'settings';

export const legacyRootFor = (pathname: string): LegacyRoot =>
  pathname === '/settings' || pathname.startsWith('/settings/')
    ? 'settings'
    : 'workspace';
