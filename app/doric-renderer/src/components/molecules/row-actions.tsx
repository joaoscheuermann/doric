import { EllipsisVerticalIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type RowAction = {
  readonly label: string;
  /** Separates a destructive action from the ones above it. */
  readonly destructive?: boolean;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
};

/**
 * One table row's actions, behind a single icon button. A row of buttons competes
 * with the data for attention and grows with every action; one menu keeps the row
 * quiet and its actions named rather than guessed from an icon.
 *
 * The trigger is the vertical ellipsis, which is the shape a reader already
 * knows as "this row has actions". Selecting an item closes the menu, because
 * Radix does that for an item's own `onSelect`.
 */
export function RowActions({
  actions,
  label,
}: {
  /** Named so a screen reader says which row this menu belongs to. */
  readonly label: string;
  readonly actions: readonly RowAction[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label={`Actions for ${label}`}
        >
          <EllipsisVerticalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action, index) => (
          <Fragment key={action.label}>
            {index > 0 && action.destructive === true && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              variant={action.destructive === true ? 'destructive' : 'default'}
              onSelect={action.onSelect}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
