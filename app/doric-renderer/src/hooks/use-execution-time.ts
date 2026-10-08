import { useEffect, useState } from 'react';

import { duration } from '@/utility/duration';

export const useExecutionTime = (startedAt?: string): string | undefined => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return undefined;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? duration(now - started) : undefined;
};
