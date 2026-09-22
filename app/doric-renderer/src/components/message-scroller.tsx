import { cn } from '@/lib/utils';
import type { ComponentProps, ReactNode } from 'react';
import { StickToBottom } from 'use-stick-to-bottom';

/**
 * The centered reading column. A row's background lives outside it, so a band
 * reaches the panel edges while the text keeps one fixed column.
 */
export function MessageColumn({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('mx-auto flex w-full max-w-3xl gap-3 px-6', className)}>
      {children}
    </div>
  );
}

export function MessageScroller({
  className,
  children,
  ...props
}: ComponentProps<typeof StickToBottom>) {
  return (
    <StickToBottom
      className={cn('relative min-h-0 flex-1 overflow-hidden', className)}
      initial="instant"
      resize="smooth"
      {...props}
    >
      <StickToBottom.Content className="flex w-full flex-col gap-4 py-8">
        {children}
      </StickToBottom.Content>
    </StickToBottom>
  );
}
