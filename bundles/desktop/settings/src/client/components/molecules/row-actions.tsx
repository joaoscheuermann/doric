import { Button } from 'desktop/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import { EllipsisVerticalIcon } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

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
 * a menu item closes its menu on click.
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
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label={`Actions for ${label}`}
          />
        }
      >
        <EllipsisVerticalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action, index) => (
          <Fragment key={action.label}>
            {index > 0 && action.destructive === true && (
              <DropdownMenuSeparator />
            )}
            <DropdownMenuItem
              variant={action.destructive === true ? 'destructive' : 'default'}
              onClick={action.onSelect}
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
