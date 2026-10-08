import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  blockOpen,
  blockToggled,
  type Chosen,
  type Openness,
} from '@/domain/collapsible';
import { cn } from '@/utility/utils';

type CollapsibleBlockProps = {
  /** The header line, which shimmers while the work is in progress. */
  readonly label: ReactNode;
  /** An independent header action, placed between sibling toggle buttons. */
  readonly action?: {
    readonly content: ReactNode;
    readonly toggleLabel: string;
  };
  /**
   * What makes the block open on its own: open while its work is in progress
   * and it has something to show, and folded away once the work settles. A
   * block that is in progress but empty — the agent's step before it has one —
   * stays closed, so opening it would only ever show nothing.
   */
  readonly openness: Openness;
  /**
   * The reader's choice of open/closed, held by the block's owner as node
   * state — so the chevron and the keyboard write one state — and `null` until
   * they make one.
   */
  readonly chosen: Chosen;
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop; it then wears the hover style. */
  readonly focused?: boolean;
  readonly children: ReactNode;
};

/**
 * A section of the transcript a reader opens and closes: a header line, and the
 * detail it holds. It opens while its work is in progress and has something to
 * show, and folds away once that work settles — until the reader chooses, after
 * which their choice stands.
 *
 * The chevron points right while the block is closed and down while it is open,
 * so one icon carries both states. A focused block's header line wears the hover
 * style, so the caret's stop looks the way the block does under the pointer.
 *
 * The block states no spacing of its own: a turn block's own top margin sets the
 * conversation's gap between it and the turn before it, and a list of these
 * inside a summary sets its own between them.
 */
export function CollapsibleBlock({
  action,
  children,
  chosen,
  focused,
  label,
  onChosenChange,
  openness,
}: CollapsibleBlockProps) {
  const open = blockOpen(chosen, openness);
  const toggle = (): void => onChosenChange(blockToggled(chosen, openness));
  const headerClass = cn(
    'flex w-full items-center gap-1 text-sm transition-colors hover:text-foreground',
    focused ? 'text-foreground' : 'text-muted-foreground',
  );
  const chevron = (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        'size-3.5 shrink-0 transition-transform',
        open && 'rotate-90',
      )}
    />
  );

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      {action === undefined ? (
        <CollapsibleTrigger className={headerClass}>
          <span className={cn('min-w-0', openness.active && 'shimmer')}>
            {label}
          </span>
          {chevron}
        </CollapsibleTrigger>
      ) : (
        <div className={headerClass}>
          <CollapsibleTrigger
            className="flex shrink-0 items-center gap-1 whitespace-nowrap"
            aria-label={action.toggleLabel}
          >
            {label}
          </CollapsibleTrigger>
          {action.content}
          <CollapsibleTrigger
            className="flex min-w-3.5 self-stretch flex-1 items-center"
            aria-label={action.toggleLabel}
          >
            {chevron}
          </CollapsibleTrigger>
        </div>
      )}
      <CollapsibleContent className="mt-1.5 ml-1.5 border-l border-border pl-3 text-sm text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
