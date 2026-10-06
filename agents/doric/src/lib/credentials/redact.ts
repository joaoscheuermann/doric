/** The one marker a redacted secret leaves in its place. */
const marker = '[REDACTED]';

/**
 * Replaces every literal occurrence of each secret with the redaction marker.
 * Secrets are applied in order, so a later secret may also match text an
 * earlier replacement introduced. Callers that must skip empty secrets filter
 * the list first, because an empty needle redacts between every character.
 */
export const redactSecrets = (
  text: string,
  secrets: readonly string[],
): string =>
  secrets.reduce(
    (redacted, secret) => redacted.split(secret).join(marker),
    text,
  );
