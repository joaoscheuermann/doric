import { Button } from '@/components/ui/button';
import { CheckIcon } from 'lucide-react';

type ChoiceListProps = {
  readonly choices: readonly {
    readonly label: string;
    /** A mark the row wears beside its label, such as the model's own default. */
    readonly note?: string;
    readonly value: string;
  }[];
  readonly onSelect: (value: string) => void;
  /** The current value, checked in the list. */
  readonly value?: string;
};

/**
 * The rows of one choice: each a ghost button that commits its value on click,
 * the current one bearing a check. It is the list shared by the footer's effort
 * menu and by the reasoning row the model popover ends with, so both choose from
 * the model's own efforts the same way.
 */
export function ChoiceList({ choices, onSelect, value }: ChoiceListProps) {
  return (
    <div className="flex flex-col">
      {choices.map((choice) => (
        <Button
          key={choice.value}
          variant="ghost"
          size="sm"
          className="w-full justify-between gap-2 font-normal"
          onClick={() => onSelect(choice.value)}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{choice.label}</span>
            {choice.note !== undefined && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {choice.note}
              </span>
            )}
          </span>
          {choice.value === value && (
            <CheckIcon aria-hidden="true" className="text-primary" />
          )}
        </Button>
      ))}
    </div>
  );
}
