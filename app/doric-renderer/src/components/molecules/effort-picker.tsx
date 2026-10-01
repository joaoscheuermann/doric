import { ChoiceList } from '@/components/molecules/choice-list';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useState } from 'react';

type EffortPickerProps = {
  readonly ariaLabel: string;
  readonly choices: readonly {
    readonly label: string;
    /** A mark the row wears beside its label, such as the model's own default. */
    readonly note?: string;
    readonly value: string;
  }[];
  /** Whether the model lists nothing to choose, so the control stays closed. */
  readonly disabled?: boolean;
  /** What the trigger reads: the selected effort's label, or a placeholder. */
  readonly label: string;
  readonly onSelect: (value: string) => void;
  readonly value?: string;
};

/**
 * The reasoning effort a prompt requests, worn as a ghost button: opening it
 * lists the efforts the model itself accepts, each a row that commits on click.
 * A model that lists none has nothing to choose, so the button is disabled and
 * the popover is never opened.
 */
export function EffortPicker({
  ariaLabel,
  choices,
  disabled = false,
  label,
  onSelect,
  value,
}: EffortPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={ariaLabel}
          disabled={disabled}
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-44 gap-0 p-1"
      >
        <ChoiceList
          choices={choices}
          value={value}
          onSelect={(next) => {
            onSelect(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
