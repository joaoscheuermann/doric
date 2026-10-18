export const asRecord = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const stringField = (
  value: Record<string, unknown>,
  field: string,
): string | undefined => {
  const child = value[field];

  return typeof child === 'string' ? child : undefined;
};

export const numberField = (
  value: Record<string, unknown>,
  field: string,
): number | undefined => {
  const child = value[field];

  return typeof child === 'number' && Number.isFinite(child)
    ? child
    : undefined;
};

export const diagnosticExcerpt = (value: string, limit = 500): string =>
  value.length <= limit ? value : `${value.slice(0, limit)}...[truncated]`;
