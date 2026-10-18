/** The text a failure shows: an `Error`'s message, else the generic sentence. */
export const messageFrom = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : 'The operation could not be completed.';

/** The most levels of a stored failure's cause chain the conversation shows. */
const MAX_CAUSES = 8;

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;

/**
 * The text of a failure the host stored as JSON: its message, then each
 * cause's on its own line, outermost first. The tool registry's
 * `handler_failed` wrapper only names the tool that threw, so the text starts
 * at what the tool threw, the same failure the model read. A cause whose
 * message an outer line already quotes adds nothing and is left out. A bare
 * string is its own text.
 */
export const failureText = (value: unknown): string => {
  if (typeof value === 'string') return value;

  const wrapped =
    fieldOf(fieldOf(value, 'data'), 'code') === 'handler_failed' &&
    fieldOf(value, 'cause') !== undefined;
  const lines: string[] = [];
  let current = wrapped ? fieldOf(value, 'cause') : value;

  for (let depth = 0; depth < MAX_CAUSES && current !== undefined; depth += 1) {
    const field =
      typeof current === 'string' ? current : fieldOf(current, 'message');
    const message = typeof field === 'string' ? field.trim() : '';

    if (message !== '' && !lines.some((line) => line.includes(message))) {
      lines.push(lines.length === 0 ? message : `Caused by: ${message}`);
    }

    current = fieldOf(current, 'cause');
  }

  return lines.join('\n');
};
