import type { ReactNode } from 'react';

type ThreadPaneProps = {
  readonly children: ReactNode;
};

/** The region a Thread's conversation is arranged in, whatever fills it. */
export function ThreadPane({ children }: ThreadPaneProps) {
  return (
    <section aria-label="Thread conversation" className="flex min-h-0 flex-1">
      {children}
    </section>
  );
}
