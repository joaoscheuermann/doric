import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import { cn } from '@/utility/utils';

/**
 * The ghost treatment for the input group a combobox draws: no outline, no fill,
 * and no ring on focus, so the current value reads as a label the reader can open
 * rather than as a field. It is also only as wide as the value it holds — the
 * input takes its width from its own text instead of a form field's — because a
 * bar has room for what it says, not for the space a field reserves. Merged over
 * the group's own classes, so each of those is replaced rather than doubled.
 */
const ghost = [
  'w-fit min-w-12 border-transparent bg-transparent shadow-none',
  'dark:bg-transparent hover:bg-muted',
  'has-[[data-slot=input-group-control]:focus-visible]:border-transparent',
  'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
  '[&>input]:w-auto [&>input]:flex-none [&>input]:px-2',
  '[&>input]:[field-sizing:content]',
].join(' ');

/**
 * One value chosen from a searchable list, worn as plain text: the input shows
 * the current choice and narrows the options as it is typed, and no chevron or
 * outline stands beside it. Selecting is the only commitment — typing filters and
 * never sets a value the list does not offer.
 *
 * A choice may carry a `detail` — the provider a model belongs to, say. It is
 * drawn in the list alone, muted, so the field stays as narrow as the value it
 * holds while the list stays able to tell two equal values apart.
 */
export function ChoiceCombobox({
  ariaLabel,
  choices,
  className,
  disabled,
  placeholder,
  value,
  onSelect,
}: {
  readonly ariaLabel: string;
  readonly choices: readonly {
    readonly detail?: string;
    readonly label: string;
    readonly value: string;
  }[];
  readonly className?: string;
  readonly disabled?: boolean;
  readonly placeholder: string;
  readonly value?: string;
  readonly onSelect: (value: string) => void;
}) {
  const current = choices.find((choice) => choice.value === value) ?? null;

  return (
    <Combobox
      items={choices}
      itemToStringValue={(choice) => choice.label}
      value={current}
      onValueChange={(chosen) => {
        if (chosen !== null) onSelect(chosen.value);
      }}
    >
      <ComboboxInput
        aria-label={ariaLabel}
        showTrigger={false}
        disabled={disabled}
        placeholder={placeholder}
        className={cn(ghost, className)}
      />
      <ComboboxContent className="min-w-64">
        <ComboboxEmpty>No match.</ComboboxEmpty>
        <ComboboxList>
          {(choice) => (
            <ComboboxItem key={choice.value} value={choice}>
              {choice.label}
              {choice.detail !== undefined && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {choice.detail}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
