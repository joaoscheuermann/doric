import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  type Configuration,
  effortLabel,
  providerLabel,
  type ReasoningEffort,
  reasoningEfforts,
  turnsFromInput,
  updateModel,
  updateTurnLimit,
} from '@/domain/config';
import { ChevronDownIcon, InfoIcon } from 'lucide-react';

type SettingsExecutionProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

type Choice = { readonly label: string; readonly value: string };

/**
 * One setting chosen from a fixed list: the trigger names the current choice and
 * the menu holds the list. An empty list cannot be opened, because nothing is
 * there to choose.
 */
function ChoicePicker({
  ariaLabel,
  choices,
  onSelect,
  value,
}: {
  readonly ariaLabel: string;
  readonly choices: readonly Choice[];
  readonly onSelect: (value: string) => void;
  readonly value: string;
}) {
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
          {current?.label ?? `Choose ${ariaLabel.toLowerCase()}`}
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

/**
 * What runs a prompt: the provider, the model on it, the reasoning effort, and
 * how many turns one prompt may take.
 */
export function SettingsExecution({ draft, onChange }: SettingsExecutionProps) {
  const { effort, model, providerId } = draft.models.execution;
  const maxTurns = draft.execution.maxTurns;

  return (
    <FieldGroup>
      <Field>
        <FieldLabel>Provider</FieldLabel>
        <ChoicePicker
          ariaLabel="Execution provider"
          choices={draft.providers.map((provider, index) => ({
            label: providerLabel(provider, index),
            value: provider.id,
          }))}
          value={providerId}
          onSelect={(next) =>
            onChange(updateModel(draft, { providerId: next }))
          }
        />
        <FieldDescription>
          The configured provider every prompt is sent to.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="execution-model">Model</FieldLabel>
        <Input
          id="execution-model"
          value={model}
          onChange={(event) =>
            onChange(updateModel(draft, { model: event.target.value }))
          }
        />
      </Field>
      <Field>
        <FieldLabel>Reasoning effort</FieldLabel>
        <ChoicePicker
          ariaLabel="Reasoning effort"
          choices={reasoningEfforts.map((value) => ({
            label: effortLabel(value),
            value,
          }))}
          value={effort}
          onSelect={(next) =>
            onChange(updateModel(draft, { effort: next as ReasoningEffort }))
          }
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="execution-max-turns">Turn limit</FieldLabel>
        <Input
          id="execution-max-turns"
          inputMode="numeric"
          value={Number.isNaN(maxTurns) ? '' : String(maxTurns)}
          onChange={(event) =>
            onChange(updateTurnLimit(draft, turnsFromInput(event.target.value)))
          }
        />
        <FieldDescription>
          The most turns a single prompt may take before it stops.
        </FieldDescription>
      </Field>
      <Alert>
        <InfoIcon />
        <AlertTitle>Applies to new Projects</AlertTitle>
        <AlertDescription>
          A Project keeps the configuration it was created with, so this change
          reaches only Projects created after it is saved. Projects already
          running keep running as they were.
        </AlertDescription>
      </Alert>
    </FieldGroup>
  );
}
