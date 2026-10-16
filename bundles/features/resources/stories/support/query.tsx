// The query client a story renders under: the activation's settings, one
// client per mounted story, seeded before the first render so a reading is
// on screen at once instead of after the first poll.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export const createStoryQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
      },
      mutations: { retry: false },
    },
  });

export function WithQueryClient({
  seed,
  children,
}: {
  readonly seed?: (client: QueryClient) => void;
  readonly children: ReactNode;
}) {
  const [client] = useState(() => {
    const created = createStoryQueryClient();
    seed?.(created);
    return created;
  });
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Clicks the first element matching `selector` inside its children once
 * they mount, so a story can show a popover the component opens only on a
 * click (its `Popover` is uncontrolled).
 */
export function OpenOnMount({
  selector,
  children,
}: {
  readonly selector: string;
  readonly children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      root.current?.querySelector<HTMLElement>(selector)?.click();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [selector]);
  return (
    <div ref={root} className="contents">
      {children}
    </div>
  );
}
