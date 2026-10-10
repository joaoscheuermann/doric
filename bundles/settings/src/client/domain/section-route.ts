// Settings sections are child routes of `/settings` (D9-14). The window opens
// at `/settings`; the page then shows the last section this window showed, or
// Providers, the section the settings window has always opened on.

export const SETTINGS_PATH = '/settings';

/** The section a window shows when it has shown none yet. */
export const DEFAULT_SECTION_PATH = '/settings/providers';

/** The route path of one section. */
export const sectionPath = (id: string): string => `${SETTINGS_PATH}/${id}`;

/** The section id a route pattern names, or `undefined` outside a section. */
export const sectionIdOf = (pattern: string | undefined): string | undefined =>
  pattern?.startsWith(`${SETTINGS_PATH}/`) === true
    ? pattern.slice(SETTINGS_PATH.length + 1)
    : undefined;

/** What `section-route` reads of `navigation/v1`. */
export interface SectionNavigation {
  current(): { readonly path: string; readonly pattern: string } | undefined;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  subscribe(listener: () => void): { dispose(): void };
}

/**
 * Follows the window's route for the settings page: a section route is
 * remembered, and the bare `/settings` is replaced by the remembered section
 * (or Providers). The memory is per window and outlives the page, so a window
 * that is told to show `/settings` again comes back to where it was.
 */
export const createSectionRoute = () => {
  let lastSection: string | undefined;

  const settle = (navigation: SectionNavigation): void => {
    const match = navigation.current();
    if (match === undefined) return;

    if (match.pattern === SETTINGS_PATH) {
      // After the notification that reported `/settings` reached every other
      // listener, so none of them is told the old route after the new one.
      queueMicrotask(() => {
        if (navigation.current()?.pattern !== SETTINGS_PATH) return;
        navigation.navigate(lastSection ?? DEFAULT_SECTION_PATH, {
          replace: true,
        });
      });
      return;
    }

    if (sectionIdOf(match.pattern) !== undefined) lastSection = match.path;
  };

  return {
    /** Settles the current route now and on every navigation until disposed. */
    follow(navigation: SectionNavigation): { dispose(): void } {
      const subscription = navigation.subscribe(() => settle(navigation));
      settle(navigation);
      return subscription;
    },
    lastSection: (): string | undefined => lastSection,
  };
};
