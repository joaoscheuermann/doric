import { ChoicePicker } from '@/components/molecules/choice-picker';
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
  modelEfforts,
  providerLabel,
  type ReasoningEffort,
  toolResultCharsFromInput,
  turnsFromInput,
  updateModel,
  updateToolResultLimit,
  updateTurnLimit,
} from '@/domain/config';

type SettingsExecutionProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

/**
 * What runs a prompt: the provider, the model on it, the reasoning effort, and
 * how many turns one prompt may take. Every prompt reads this as it runs, so a
 * choice here reaches a Project that is already running.
 */
export function SettingsExecution({ draft, onChange }: SettingsExecutionProps) {
  const { effort, model, providerId } = draft.models.execution;
  const maxTurns = draft.execution.maxTurns;
  // The selected provider may hold the models it offers, and each model its own
  // reasoning efforts. When the model lists them they become the choices; when
  // it lists none — or no model is named — the field stays free, because a
  // provider that declares no models can be called with any, and a model whose
  // efforts are unknown is taken to accept the whole set.
  const provider = draft.providers.find((entry) => entry.id === providerId);
  const models = provider?.models ?? [];
  // The model's own efforts, and nothing else: a model that lists none offers no
  // choice at all, because what it accepts is the catalog's to say.
  const reasonings = modelEfforts(draft, providerId, model).filter(
    (effort) => effort !== 'none',
  );
  const efforts = reasonings.map((value) => ({
    label: effortLabel(value),
    value,
  }));

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
        {models.length === 0 ? (
          <Input
            id="execution-model"
            value={model}
            onChange={(event) =>
              onChange(updateModel(draft, { model: event.target.value }))
            }
          />
        ) : (
          <ChoicePicker
            ariaLabel="Execution model"
            choices={models.map((entry) => ({
              label: entry.name,
              value: entry.name,
            }))}
            value={model}
            onSelect={(next) => onChange(updateModel(draft, { model: next }))}
          />
        )}
      </Field>
      <Field>
        <FieldLabel>Reasoning effort</FieldLabel>
        <ChoicePicker
          ariaLabel="Reasoning effort"
          choices={efforts}
          emptyLabel="Not offered by this model"
          value={effort ?? ''}
          onSelect={(next) =>
            onChange(updateModel(draft, { effort: next as ReasoningEffort }))
          }
        />
        <FieldDescription>
          {efforts.length === 0
            ? 'This model does not list the reasoning efforts it accepts, so no effort is sent with a prompt.'
            : 'The efforts this model lists in the provider catalog.'}
        </FieldDescription>
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
      <Field>
        <FieldLabel htmlFor="execution-tool-result-chars">
          Tool result limit
        </FieldLabel>
        <Input
          id="execution-tool-result-chars"
          inputMode="numeric"
          value={
            draft.execution.maxToolResultChars === undefined
              ? ''
              : String(draft.execution.maxToolResultChars)
          }
          onChange={(event) =>
            onChange(
              updateToolResultLimit(
                draft,
                toolResultCharsFromInput(event.target.value),
              ),
            )
          }
        />
        <FieldDescription>
          The most characters of one tool result that reach the model. Leave it
          empty for no cap; the full result is still recorded.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
