export const maximumNameLength = 80;

export const normalizeName = (value: string): string => value.trim();

export const isValidName = (value: string): boolean =>
  !value.includes('\0') &&
  Array.from(value).length >= 1 &&
  Array.from(value).length <= maximumNameLength;

/** Produces a valid display name without splitting a Unicode surrogate pair. */
export const nameFromPrompt = (prompt: string): string =>
  Array.from(normalizeName(prompt).replaceAll('\0', '\uFFFD'))
    .slice(0, maximumNameLength)
    .join('');
