/**
 * An identifier as prose: the separators a code name uses become spaces, so a
 * tool's name can stand in a sentence — `read_file` reads as `read file`.
 */
export const humanize = (name: string): string =>
  name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
