/**
 * The transcript's open-and-close section and its generic rule.
 *
 * A block opens on its own while its work is in progress and it has something to
 * show, and folds away once the work settles. The reader may override that at
 * any time, and their choice then stands — over the default and over every later
 * change of the work — because it is their transcript to read. The override is
 * held by the block's owner, so the chevron and the keyboard write one state;
 * `null` means the reader has not chosen and the default decides.
 */
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './components/collapsible.js';
import { cn } from './lib/utils.js';

/** The reader's choice of open/closed; `null` until they make one. */
export type Chosen = boolean | null;

/**
 * What makes a block open while the reader has not chosen. A block's owner
 * computes it from the block's own work; `blockOpen` reads it.
 */
export type Openness = {
  /** Whether the work is in progress. */
  readonly active: boolean;
  /** Whether there is anything to show. */
  readonly hasContent: boolean;
  /** Whether the block stays open after its work settles until the reader folds it. */
  readonly defaultOpen?: boolean;
};

/**
 * What a block shows now. Answers the reader's choice when there is one;
 * otherwise `(defaultOpen ?? active) && hasContent`, so an empty block is
 * never open on its own. Total and pure: it never throws.
 */
export const blockOpen = (chosen: Chosen, open: Openness): boolean =>
  chosen ?? ((open.defaultOpen ?? open.active) && open.hasContent);

/**
 * The reader's next choice when they open or close a block: whatever the block
 * shows now, they want the other. Always `!blockOpen(chosen, open)`; pure,
 * never throws.
 */
export const blockToggled = (chosen: Chosen, open: Openness): boolean =>
  !blockOpen(chosen, open);

export type CollapsibleBlockProps = {
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
   * block that is in progress but empty stays closed.
   */
  readonly openness: Openness;
  /**
   * The reader's choice of open/closed, held by the block's owner — so the
   * chevron and the keyboard write one state — and `null` until they make one.
   */
  readonly chosen: Chosen;
  /** Called with `blockToggled(chosen, openness)` when the reader clicks the header. */
  readonly onChosenChange: (chosen: boolean) => void;
  /** Whether the block is the caret's stop; it then wears the hover style. */
  readonly focused?: boolean;
  /** Whether the open content draws the left vertical guide line; defaults to true. */
  readonly guide?: boolean;
  /** Optional control rendered at the right end of the header row (e.g. Stop). */
  readonly trailing?: ReactNode;
  /** What a screen reader names the header's toggle by, when not its text. */
  readonly toggleLabel?: string;
  /** The detail the open block shows; `createElement`'s children may give it. */
  readonly children?: ReactNode;
};

/**
 * A section of the transcript a reader opens and closes: a header line, and the
 * detail it holds. It shows `blockOpen(chosen, openness)`: open while its work
 * is in progress and has something to show, folded once that work settles —
 * until the reader chooses, after which their choice stands. It holds no state
 * of its own; a click only reports the next choice through `onChosenChange`.
 *
 * The chevron points right while closed and down while open. A focused block's
 * header wears the hover style. The block states no outer spacing of its own.
 */
export function CollapsibleBlock({
  action,
  children,
  chosen,
  focused,
  guide = true,
  label,
  onChosenChange,
  openness,
  toggleLabel,
  trailing,
}: CollapsibleBlockProps): React.JSX.Element {
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
        trailing === undefined ? (
          <CollapsibleTrigger className={headerClass} aria-label={toggleLabel}>
            <span className={cn('min-w-0', openness.active && 'shimmer')}>
              {label}
            </span>
            {chevron}
          </CollapsibleTrigger>
        ) : (
          <div className="flex w-full items-center gap-2">
            <CollapsibleTrigger
              className={cn(headerClass, 'w-auto min-w-0 flex-1')}
              aria-label={toggleLabel}
            >
              <span className={cn('min-w-0', openness.active && 'shimmer')}>
                {label}
              </span>
              {chevron}
            </CollapsibleTrigger>
            {trailing}
          </div>
        )
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
          {trailing}
        </div>
      )}
      <CollapsibleContent
        className={cn(
          'mt-1.5 text-sm text-muted-foreground',
          guide && 'ml-1.5 border-l border-border pl-3',
        )}
      >
        {open ? children : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
