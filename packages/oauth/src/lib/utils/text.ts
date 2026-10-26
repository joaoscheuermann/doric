/** The trimmed value, or `undefined` when it is absent or blank. */
export const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
};

/** The token of an `Authorization` value, without its `Bearer ` scheme. */
export const bearerToken = (value: string): string =>
  value.toLowerCase().startsWith('bearer ')
    ? value.slice('bearer '.length).trimStart()
    : value;
