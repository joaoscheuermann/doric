import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * The monospace surface shared by tool payloads and delegated results. Content
 * stays verbatim — no Markdown — so a table or fence inside a payload cannot
 * lose or reinterpret what the sender actually wrote.
 */
export function Payload({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <pre
      className={cn(
        'rounded-sm bg-secondary/40 px-2 py-1.5 font-mono text-sm leading-5 whitespace-pre-wrap text-muted-foreground/80 select-text',
        className,
      )}
    >
      {children}
    </pre>
  );
}
