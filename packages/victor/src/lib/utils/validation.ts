import type { Logger } from 'pino';

export const invalid = (subject: string, message: string): TypeError =>
  new TypeError(`Invalid ${subject} ${message}.`);

export function validateLogger(
  logger: unknown,
  subject: string,
): asserts logger is Logger {
  if (
    typeof logger !== 'object' ||
    logger === null ||
    typeof (logger as { debug?: unknown }).debug !== 'function' ||
    typeof (logger as { child?: unknown }).child !== 'function'
  ) {
    throw invalid(
      subject,
      'logger: expected an object with debug and child functions',
    );
  }
}

export const validateTopK = (topK: number, subject: string): void => {
  if (!Number.isSafeInteger(topK) || topK < 0) {
    throw invalid(subject, 'topK: expected a nonnegative safe integer');
  }
};
