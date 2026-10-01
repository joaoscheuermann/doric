import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDownIcon } from 'lucide-react';

/** One value a picker offers, under the name the trigger and the menu show it. */
export type Choice = { readonly label: string; readonly value: string };

type ChoicePickerProps = {
  readonly ariaLabel: string;
  readonly choices: readonly Choice[];
  /** What the trigger reads when the current value names no choice. */
  readonly emptyLabel?: string;
  readonly onSelect: (value: string) => void;
  readonly value: string;
};

/**
 * One setting chosen from a fixed list: the trigger names the current choice and
 * the menu holds the list. An empty list cannot be opened, because nothing is
 * there to choose, and a value the list does not name reads under `emptyLabel`
 * rather than as no choice at all.
 */
export function ChoicePicker({
  ariaLabel,
  choices,
  emptyLabel,
  onSelect,
  value,
}: ChoicePickerProps) {
  const current = choices.find((choice) => choice.value === value);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-fit justify-between"
          aria-label={ariaLabel}
          disabled={choices.length === 0}
        >
          {current?.label ?? emptyLabel ?? `Choose ${ariaLabel.toLowerCase()}`}
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={onSelect}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
