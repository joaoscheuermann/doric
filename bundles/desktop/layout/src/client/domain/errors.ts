/** The text a failed request shows: its own message, or the generic sentence. */
export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';
