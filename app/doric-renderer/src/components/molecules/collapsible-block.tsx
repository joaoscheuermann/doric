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
  /** Whether the work is in progress: the block opens, and the label shimmers. */
  readonly active: boolean;
  readonly children: ReactNode;
};

/**
 * A section of the transcript a reader opens and closes: a header line, and the
 * detail it holds. It opens while its work is in progress and folds away once
 * that work settles — until the reader clicks, after which their choice stands.
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
  label,
}: CollapsibleBlockProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? active;

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
