/**
 * A settings section as a search sees it: the text a reader can type. The nav
 * draws an id and an icon beside that text, and neither is something anyone
 * searches for.
 */
export type SettingsSection = {
  readonly description?: string;
  readonly label: string;
};

/**
 * The sections a query keeps, in the order they were given.
 *
 * Matching is case-insensitive and matches anywhere in the text, because a
 * reader looking for the turn limit types "turns" long before they know that
the section holding it is named Execution. A query of nothing but blank space
keeps every section, so a stray space never empties the list.
 */
export const filterSettingsSections = <T extends SettingsSection>(
  sections: readonly T[],
  query: string,
): readonly T[] => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return sections;

  return sections.filter(
    (section) =>
      section.label.toLowerCase().includes(needle) ||
      (section.description?.toLowerCase().includes(needle) ?? false),
  );
};
