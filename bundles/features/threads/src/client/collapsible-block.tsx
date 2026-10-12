// The transcript's collapsible block, as chat's
// `components/molecules/collapsible-block.tsx` draws it, for the one shape a
// delegated input uses: a header with an independent action between two
// toggle buttons, settled (never in progress), so the reader's choice alone
// decides whether it is open.

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import { cn } from 'desktop/ui/utils';
import { ChevronRightIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function CollapsibleBlock({
  action,
  children,
  open,
  focused,
  label,
  onOpenChange,
}: {
  readonly label: ReactNode;
  readonly action: {
    readonly content: ReactNode;
    readonly toggleLabel: string;
  };
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly focused?: boolean;
  readonly children: ReactNode;
}) {
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
    <Collapsible open={open} onOpenChange={() => onOpenChange(!open)}>
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
      <CollapsibleContent className="mt-1.5 ml-1.5 border-l border-border pl-3 text-sm text-muted-foreground">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
