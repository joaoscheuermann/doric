import type { ModelGroup } from 'settings/contracts';

/**
 * The groups narrowed to the choices whose label contains `query`, headings
 * kept and emptied groups dropped. An empty query — or one with nothing but
 * whitespace — keeps every group, so clearing the field restores the list.
 */
export const searchModelGroups = (
  groups: readonly ModelGroup[],
  query: string,
): readonly ModelGroup[] => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return groups;

  return groups
    .map((group) => ({
      ...(group.label === undefined ? {} : { label: group.label }),
      choices: group.choices.filter((choice) =>
        choice.label.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.choices.length > 0);
};
