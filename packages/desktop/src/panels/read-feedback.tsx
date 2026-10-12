import { useReadError } from './use-read-error.js';

/** Read failures use the app's toast surface without displacing cached content. */
export function ReadFeedback({
  error,
  refreshing,
  onRetry,
  toastId,
}: {
  readonly error?: string;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
  readonly toastId?: string;
}) {
  useReadError(error, refreshing, onRetry, toastId);
  return null;
}
