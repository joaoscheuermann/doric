// `doric.appearance/v1`, the app's theme preference (§4.1). The ref is declared
// here by id and the interface imported as a type only: an app older than
// 1.3.0 does not export `DoricAppearanceV1` from `bundle/contracts`, and a
// static import of it would fail this part at link time (S35).

import { type DoricAppearance, type DoricTheme, ref } from 'bundle/contracts';

/** The app's theme preference, answered by the window through `doric.shell/v1`. */
export const AppearanceV1 = ref<DoricAppearance>('doric.appearance/v1');

/** The themes the Appearance section offers, in the order of its tiles. */
export const themes = [
  'dark',
  'light',
  'system',
] as const satisfies readonly DoricTheme[];

export type Theme = (typeof themes)[number];
