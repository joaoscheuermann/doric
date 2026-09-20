/** Bounds diagnostic size without interpreting or sanitizing its content. */
export const diagnosticExcerpt = (value: string, limit = 2048): string => {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit)}...[truncated]`;
};
