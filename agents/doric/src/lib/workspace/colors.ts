/**
 * The colors a Project can be marked with. The host owns this vocabulary: a
 * client names one of these colors, and every surface decides how to paint it.
 * A Project with no color keeps the field absent rather than storing a default.
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

export const isProjectColor = (value: unknown): value is ProjectColor =>
  typeof value === 'string' &&
  (projectColors as readonly string[]).includes(value);
