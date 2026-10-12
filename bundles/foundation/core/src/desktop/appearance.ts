import type { WindowAppearance } from 'bundle/contracts';

/** The workspace window's sizes today (P1); the title bar is integrated. */
export const WORKSPACE_APPEARANCE = {
  size: { width: 1280, height: 800, minWidth: 960, minHeight: 640 },
  titleBar: 'integrated',
} as const satisfies WindowAppearance;

/** The settings window's sizes today (P2); the title bar is integrated. */
export const SETTINGS_APPEARANCE = {
  size: { width: 960, height: 720, minWidth: 720, minHeight: 520 },
  titleBar: 'integrated',
} as const satisfies WindowAppearance;
