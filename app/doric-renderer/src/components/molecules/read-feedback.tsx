import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { AlertCircleIcon } from 'lucide-react';

/** Read failures stay beside cached content and offer recovery at the failure. */
export function ReadFeedback({
  error,
  refreshing,
  onRetry,
}: {
  readonly error?: string;
  readonly refreshing: boolean;
  readonly onRetry: () => void;
}) {
  if (error === undefined) return null;
  return (
    <Alert variant="destructive" className="mx-2 my-1 w-auto shrink-0">
      <AlertCircleIcon />
      <AlertTitle>Unable to update</AlertTitle>
      <AlertDescription>
        <p>{error}</p>
        <p>Previously loaded content may be out of date.</p>
        <Button
          variant="outline"
          size="sm"
          disabled={refreshing}
          onClick={onRetry}
        >
          {refreshing ? 'Updating…' : 'Try again'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
