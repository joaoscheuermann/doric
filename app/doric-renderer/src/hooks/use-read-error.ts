import { useEffect, useId, useRef } from 'react';
import { toast } from 'sonner';

/** One recoverable toast per read surface; successful reads dismiss it. */
export function useReadError(
  error: string | undefined,
  refreshing: boolean,
  onRetry: () => void,
) {
  const id = useId();
  const retry = useRef(onRetry);
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    retry.current = onRetry;
  }, [onRetry]);
  useEffect(() => {
    if (error === undefined) {
      announced.current = undefined;
      toast.dismiss(id);
      return;
    }
    if (refreshing || announced.current === error) return;
    announced.current = error;
    toast.error('Unable to update', {
      id,
      description: error,
      duration: 8000,
      action: {
        label: 'Try again',
        onClick: () => {
          announced.current = undefined;
          retry.current();
        },
      },
    });
  }, [error, refreshing, id]);
  useEffect(
    () => () => {
      announced.current = undefined;
      toast.dismiss(id);
    },
    [id],
  );
}
