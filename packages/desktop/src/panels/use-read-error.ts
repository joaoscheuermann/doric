import { useEffect, useId, useRef } from 'react';

import { toast } from '../components/sonner.js';

/**
 * One recoverable toast per read surface; successful reads dismiss it. Surfaces
 * that share one toast pass the same fixed `toastId`; otherwise each surface
 * gets its own.
 */
export function useReadError(
  error: string | undefined,
  refreshing: boolean,
  onRetry: () => void,
  toastId?: string,
) {
  const ownId = useId();
  const id = toastId ?? ownId;
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
