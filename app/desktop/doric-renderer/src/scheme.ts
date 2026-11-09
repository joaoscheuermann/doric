/**
 * Keeps `.dark` on `root` equal to `prefers-color-scheme: dark`. The class is
 * set now and again on every change of the media query, which
 * `nativeTheme.themeSource` drives.
 *
 * Accepts: the element that carries the class. Defaults to
 * `document.documentElement`, since Tailwind's `dark` variant is
 * `&:is(.dark *)`.
 * Returns: nothing. The listener stays for the page's lifetime.
 * Fails: never in a window with `matchMedia`, but throws where `matchMedia` is
 * missing.
 * Invariant: once this returns, `root.classList.contains('dark')` equals
 * `matchMedia('(prefers-color-scheme: dark)').matches`. It touches no other
 * class.
 * Callers: the window bootstrap (`bootstrap.ts`) and the doric-e2e fixture
 * shell (`shell-bootstrap.mjs`).
 */
export function followScheme(
  root: HTMLElement = document.documentElement,
): void {
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const sync = () => root.classList.toggle('dark', scheme.matches);
  sync();
  scheme.addEventListener('change', sync);
}
