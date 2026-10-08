/**
 * The colors a Project can be marked with. The host owns this vocabulary: a
 * client names one of these colors, and every surface decides how to paint it.
 * Every new Project is created with one, and clearing it through the color route
 * leaves the field absent rather than storing a default.
 */
export const projectColors = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export type ProjectColor = (typeof projectColors)[number];

/** Picks the color a new Project is marked with. */
export const randomProjectColor = (): ProjectColor =>
  projectColors[Math.floor(Math.random() * projectColors.length)];

export const isProjectColor = (value: unknown): value is ProjectColor =>
  typeof value === 'string' &&
  (projectColors as readonly string[]).includes(value);
