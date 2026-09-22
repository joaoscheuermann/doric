import { cn } from '@/lib/utils';
import { ChevronRightIcon } from 'lucide-react';
import { useId, useState } from 'react';

import type { ThinkingSegment } from './projector';

/**
 * The reasoning row: its label is the whole affordance and the chevron on the
 * right shows whether it is open. It pulses while the turn is still reasoning.
 */
export function Thinking({
  segment,
  pulsing,
}: {
  readonly segment: ThinkingSegment;
  readonly pulsing: boolean;
}) {
  const [manual, setManual] = useState<boolean | undefined>();
  const contentId = useId();

  if (segment.text.trim().length === 0) return null;

  // Expanded while the turn is still reasoning, collapsed once it finishes.
  const expanded = manual ?? pulsing;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={expanded}
        className={cn(
          'flex w-full items-center gap-2 text-left text-sm leading-7 text-muted-foreground hover:text-foreground',
          pulsing && 'animate-pulse',
        )}
        onClick={() => setManual(!expanded)}
      >
        Thinking
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div
          id={contentId}
          className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground/80"
        >
          {segment.text}
        </div>
      )}
    </div>
  );
}
