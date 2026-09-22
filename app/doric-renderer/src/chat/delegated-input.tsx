import { cn } from '@/lib/utils';
import { ChevronRightIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { type DelegatedInput, threadLabel } from './delegated';
import { Payload } from './payload';

/**
 * The input of a turn written by another Thread — a child's result or a parent's
 * instruction. It reads like the secondary rows of the turn it belongs to: a
 * label, the writing Thread's name, its status and a chevron, collapsed by
 * default, expanding to the sender's own words on the shared payload surface.
 */
export function Delegated({
  segment,
  name,
}: {
  readonly segment: DelegatedInput;
  /** The writing Thread's name, when the cached tree knows it. */
  readonly name?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const label =
    segment.kind === 'result' ? 'Result from thread' : 'Task from thread';
  const thread = threadLabel(segment.threadId, name);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-controls={contentId}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 text-left text-sm leading-7 text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="shrink-0 font-medium">{label}</span>
        <span
          className={cn(
            'min-w-0 max-w-64 truncate',
            thread.mono && 'font-mono',
          )}
        >
          {thread.value}
        </span>
        {segment.status !== undefined && (
          <span className="shrink-0">· {segment.status}</span>
        )}
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      </button>
      {expanded && (
        <div id={contentId}>
          <Payload>{segment.text}</Payload>
        </div>
      )}
    </div>
  );
}
