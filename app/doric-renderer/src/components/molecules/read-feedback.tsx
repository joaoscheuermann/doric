import { useReadError } from '@/hooks/use-read-error';

/** Read failures use the app's toast surface without displacing cached content. */
export function ReadFeedback({
  error,
  refreshing,
  onRetry,
}: {
  readonly error?: string;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
}) {
  useReadError(error, refreshing, onRetry);
  return null;
}
