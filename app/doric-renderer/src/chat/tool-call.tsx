import { cn } from '@/lib/utils';
import { ChevronRightIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { Payload } from './payload';
import type { ToolSegment } from './projector';
import {
  NO_RESULT,
  prettyResult,
  resultText,
  toolStatus,
} from './tool-display';

/**
 * One tool call: `Call <name>` is the toggle and the chevron beside it shows
 * whether the payload is open. Arguments live only in the expanded `Input`.
 * Completion is silent — only the active call carries a pulsing dot — and a
 * failed call is the sole color signal.
 */
export function ToolCall({
  segment,
  terminal,
  active,
}: {
  readonly segment: ToolSegment;
  readonly terminal: boolean;
  readonly active: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const resultId = useId();
  const status = toolStatus(segment, terminal);
  const full = resultText(segment, status, true);
  const shown = resultText(segment, status, showAll);
  const truncated = shown !== full;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 leading-7">
        {active && (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground"
          />
        )}
        <button
          type="button"
          aria-controls={resultId}
          aria-expanded={expanded}
          className={cn(
            'flex w-full items-center gap-2 text-left text-sm hover:text-foreground',
            status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="shrink-0 font-medium">Call</span>
          <span className="shrink-0 font-mono">{segment.name}</span>
          <span className="sr-only">
            {status === 'incomplete' ? NO_RESULT : status}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 transition-transform',
              expanded && 'rotate-90',
            )}
          />
        </button>
      </div>
      {expanded && (
        <div className="flex flex-col gap-2" id={resultId}>
          {segment.args && (
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground/60">Input</p>
              <Payload>{prettyResult(segment.args)}</Payload>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground/60">Output</p>
            {status === 'incomplete' ? (
              <p className="text-sm text-muted-foreground/60">{NO_RESULT}</p>
            ) : (
              shown && (
                <Payload className={truncated ? 'line-clamp-6' : undefined}>
                  {shown}
                </Payload>
              )
            )}
          </div>
          {truncated && (
            <button
              type="button"
              className="self-start text-sm text-muted-foreground/60 hover:text-foreground"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
