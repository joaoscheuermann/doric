// The theme main gives Electron's `nativeTheme.themeSource`, decided in one
// place (S3, §4.1). It imports no Electron, so it is tested with plain inputs.

import { type DoricTheme, doricThemeSchema } from 'bundle/contracts';

/**
 * The value main gives `nativeTheme.themeSource`: the platform's theme union
 * (`bundle/contracts`), the same one Electron accepts, so callers can assign
 * it directly.
 */
export type ThemeSource = DoricTheme;

const isThemeSource = (value: string | undefined): value is ThemeSource =>
  doricThemeSchema.safeParse(value).success;

/**
 * Which theme the app shows.
 *
 * Accepts: `packaged`, which is Electron's `app.isPackaged` and never
 * `DesktopPlatformOptions.packaged`; the process environment; and the stored
 * preference of `appearance.json`, when one is known.
 * Returns: `env.DORIC_THEME` when `packaged` is `false` and the value is
 * exactly `'light'`, `'dark'` or `'system'` (case-sensitive, no trimming).
 * Otherwise `stored`, and `'dark'` when nothing is stored. A packaged build
 * never reads `DORIC_THEME`.
 * Fails: never. It neither throws nor reads anything beyond its input.
 * Invariant: the function is pure; `DORIC_THEME` is a development switch and
 * never changes what is stored.
 */
export const resolveThemeSource = ({
  packaged,
  env,
  stored,
}: {
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly stored?: ThemeSource;
}): ThemeSource =>
  !packaged && isThemeSource(env.DORIC_THEME)
    ? env.DORIC_THEME
    : (stored ?? 'dark');

/**
 * Saves a theme choice, then shows it.
 *
 * Accepts: the store to save into, the chosen theme, and the inputs of
 * `resolveThemeSource`; `setThemeSource` assigns `nativeTheme.themeSource`.
 * Returns: once `store.set(theme)` resolved and `setThemeSource` was called
 * once with `resolveThemeSource({ packaged, env, stored: theme })`.
 * Fails: with the store's rejection, rethrown; `setThemeSource` is then never
 * called, so the app keeps showing the theme that is still saved.
 */
export const applyTheme = async ({
  store,
  theme,
  packaged,
  env,
  setThemeSource,
}: {
  readonly store: { set(theme: ThemeSource): Promise<void> };
  readonly theme: ThemeSource;
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly setThemeSource: (source: ThemeSource) => void;
}): Promise<void> => {
  await store.set(theme);
  setThemeSource(resolveThemeSource({ packaged, env, stored: theme }));
};
