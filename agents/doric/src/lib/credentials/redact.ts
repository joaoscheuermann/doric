/** The one marker a redacted secret leaves in its place. */
const marker = '[REDACTED]';

/**
 * Replaces every literal occurrence of each secret with the redaction marker.
 * Empty secrets are ignored, because an empty needle would otherwise redact
 * between every character. Secrets are applied in order, so a later secret may
 * also match text an earlier replacement introduced.
 */
export const redactSecrets = (
  text: string,
  secrets: readonly string[],
): string =>
  secrets.reduce(
    (redacted, secret) =>
      secret === '' ? redacted : redacted.split(secret).join(marker),
    text,
  );
