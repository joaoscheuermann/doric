/** The text a failure shows: an `Error`'s message, else the generic sentence. */
export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';
