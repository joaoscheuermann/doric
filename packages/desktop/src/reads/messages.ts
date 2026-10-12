/** The message a failed operation shows: its own, or the generic sentence. */
export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';
