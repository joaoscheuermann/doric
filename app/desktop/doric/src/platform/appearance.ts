// The theme main gives Electron's `nativeTheme.themeSource`, decided in one
// place (S3). It imports no Electron, so it is tested with plain inputs.

/**
 * The value main gives `nativeTheme.themeSource`. It is the same union
 * Electron accepts, so callers can assign it directly.
 */
export type ThemeSource = 'dark' | 'light' | 'system';

const sources: readonly string[] = ['dark', 'light', 'system'];

const isThemeSource = (value: string | undefined): value is ThemeSource =>
  value !== undefined && sources.includes(value);

/**
 * Which theme the app shows. In phases 1–3 that is always `'dark'` (UR8).
 *
 * Accepts: `packaged`, which is Electron's `app.isPackaged` and never
 * `DesktopPlatformOptions.packaged`, and the process environment.
 * Returns: `env.DORIC_THEME` when `packaged` is `false` and the value is
 * exactly `'light'`, `'dark'` or `'system'` (case-sensitive, no trimming).
 * Otherwise it returns `'dark'`: when `DORIC_THEME` is missing, empty or
 * unknown, and always in a packaged build.
 * Fails: never. It neither throws nor reads anything beyond its input.
 * Invariant: the function is pure, and a packaged build always gets `'dark'`.
 * Phase 4.1 adds the stored preference here.
 */
export const resolveThemeSource = ({
  packaged,
  env,
}: {
  readonly packaged: boolean;
  readonly env: NodeJS.ProcessEnv;
}): ThemeSource =>
  !packaged && isThemeSource(env.DORIC_THEME) ? env.DORIC_THEME : 'dark';
