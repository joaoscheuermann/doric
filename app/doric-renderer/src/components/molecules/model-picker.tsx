import { ChoiceList } from '@/components/molecules/choice-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { type ModelGroup, searchModelGroups } from '@/domain/config';
import { ChevronRightIcon, SearchIcon } from 'lucide-react';
import { useState } from 'react';

/** The reasoning control the popover ends with, when the model can think. */
type Reasoning = {
  readonly choices: readonly {
    readonly label: string;
    /** A mark the row wears beside its label, such as the model's own default. */
    readonly note?: string;
    readonly value: string;
  }[];
  /** What the row reads on the right: the effort in force, or a placeholder. */
  readonly label: string;
  readonly onSelect: (value: string) => void;
  readonly value?: string;
};

type ModelPickerProps = {
  readonly ariaLabel: string;
  /** The provider-labelled model groups the picker lists. */
  readonly groups: readonly ModelGroup[];
  /** What the trigger reads: the selected model's name, or a placeholder. */
  readonly label: string;
  readonly onSelect: (value: string) => void;
  /** The model's reasoning, offered from the same popover as the model is. */
  readonly reasoning?: Reasoning;
  /** The composite key of the selected model, for the check the list draws. */
  readonly value: string;
};

/**
 * The model a prompt runs on, worn as a ghost button: opening it shows a search
 * field over the models each provider lists, grouped under the provider's label,
 * and the model's reasoning as the row the popover ends with. The search narrows
 * the list and never sets a value, so selecting is the only commitment.
 *
 * It is a popover rather than a combobox because the list is a menu of choices —
 * a model, and the effort it thinks at — not a field to type a model into.
 */
export function ModelPicker({
  ariaLabel,
  groups,
  label,
  onSelect,
  reasoning,
  value,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = searchModelGroups(groups, query);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={ariaLabel}
          className="max-w-72 min-w-0"
        >
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-80 gap-0 p-0"
      >
        <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
          <SearchIcon
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <Input
            autoComplete="off"
            autoFocus
            className="h-6 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No model matches.
            </p>
          ) : (
            matches.map((group, index) => (
              <div key={group.label ?? `group-${index}`}>
                {group.label !== undefined && (
                  <div className="px-2 pt-2 pb-0.5 text-xs text-muted-foreground">
                    {group.label}
                  </div>
                )}
                <ChoiceList
                  choices={group.choices}
                  value={value}
                  onSelect={(next) => {
                    onSelect(next);
                    setOpen(false);
                  }}
                />
              </div>
            ))
          )}
        </div>
        {reasoning !== undefined && (
          <div className="border-t p-1">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between gap-2 font-normal"
                >
                  Reasoning
                  <span className="flex items-center gap-1 text-muted-foreground">
                    {reasoning.label}
                    <ChevronRightIcon aria-hidden="true" />
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="right"
                sideOffset={4}
                className="w-40 gap-0 p-1"
              >
                <ChoiceList
                  choices={reasoning.choices}
                  value={reasoning.value}
                  onSelect={(next) => {
                    reasoning.onSelect(next);
                    setOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
