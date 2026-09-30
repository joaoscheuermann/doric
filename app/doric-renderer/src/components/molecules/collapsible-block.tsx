import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/utility/utils';
import { ChevronRightIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

type CollapsibleBlockProps = {
  /** The header line, which shimmers while the work is in progress. */
  readonly label: string;
  /** Whether the work is in progress: the label shimmers. */
  readonly active: boolean;
  /**
   * Whether there is anything to show yet. A block that is in progress but
   * empty — the agent's step before it has one — stays closed, so opening it
   * would only ever show nothing.
   */
  readonly hasContent: boolean;
  readonly children: ReactNode;
};

/**
 * A section of the transcript a reader opens and closes: a header line, and the
 * detail it holds. It opens while its work is in progress and has something to
 * show, and folds away once that work settles — until the reader clicks, after
 * which their choice stands.
 *
 * The chevron points right while the block is closed and down while it is open,
 * so one icon carries both states.
 *
 * The block states no spacing of its own: a turn block's own top margin sets the
 * conversation's gap between it and the turn before it, and a list of these
 * inside a summary sets its own between them.
 */
export function CollapsibleBlock({
  active,
  children,
  hasContent,
  label,
}: CollapsibleBlockProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? (active && hasContent);

  return (
    <Collapsible open={open} onOpenChange={setChosen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <span className={cn(active && 'shimmer')}>{label}</span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 ml-1.5 border-l border-border pl-3 text-sm text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
