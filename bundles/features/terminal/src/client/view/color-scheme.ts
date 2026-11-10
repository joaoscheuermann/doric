/** What `followColorScheme` reads of a `MediaQueryList`. */
export interface SchemeQuery {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/**
 * Calls `onChange` on each `change` of `media`, the window's
 * `(prefers-color-scheme: dark)` query, so an open terminal repaints when the
 * theme changes (S21); the answer stops following it.
 */
export const followColorScheme = (
  media: SchemeQuery,
  onChange: () => void,
): (() => void) => {
  const listener = () => onChange();
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};
