import type { MenuSkeleton } from 'bundle/contracts';

/**
 * The application menu skeleton: Electron's default template, one role per
 * top-level menu, so the menu and its shortcuts stay as they are today
 * (decision 78). Main expands each role with Electron; the labels of role
 * entries are Electron's [S8-14]. The concept skeleton's "Settings" item is
 * not added [S8-16].
 */
export const defaultMenuSkeleton: MenuSkeleton = [
  { id: 'app', label: 'App', role: 'appMenu' },
  { id: 'file', label: 'File', role: 'fileMenu' },
  { id: 'edit', label: 'Edit', role: 'editMenu' },
  { id: 'view', label: 'View', role: 'viewMenu' },
  { id: 'window', label: 'Window', role: 'windowMenu' },
  { id: 'help', label: 'Help', role: 'help' },
];
