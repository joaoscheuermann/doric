import { useEffect, useState } from 'react';

/** The reader's light or dark mode, as a canvas renders under it. */
export type CanvasTheme = 'light' | 'dark';

/**
 * The theme the app is in now: `dark` while the root element carries the
 * `dark` class, else `light` (also without a document).
 */
export const appTheme = (): CanvasTheme =>
  typeof document !== 'undefined' &&
  document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';

/**
 * The theme the app is in, followed live: the app switches its mode by the
 * `dark` class of its root element, so the hook watches that class. Reads
 * `light` where there is no document or no `MutationObserver`.
 */
export const useAppTheme = (): CanvasTheme => {
  const [theme, setTheme] = useState<CanvasTheme>(appTheme);

  useEffect(() => {
    setTheme(appTheme());

    if (
      typeof document === 'undefined' ||
      typeof MutationObserver === 'undefined'
    )
      return;

    const observer = new MutationObserver(() => setTheme(appTheme()));

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
};
