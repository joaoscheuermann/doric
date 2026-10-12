/** The text a failure shows: its own message, or the generic one. */
export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';
