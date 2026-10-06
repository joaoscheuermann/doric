import { EffortPicker } from '@/components/molecules/effort-picker';
import { ModelPicker } from '@/components/molecules/model-picker';
import { Input } from '@/components/ui/input';
import {
  effortLabel,
  modelChoiceKey,
  modelDefaultEffort,
  modelEfforts,
  modelGroups,
  type ReasoningEffort,
  selectModelChoice,
  setExecutionEffort,
  updateModel,
} from '@/domain/config';
import { useConfig } from '@/hooks/use-config';
import { useProviderKinds } from '@/hooks/use-provider-kinds';

/**
 * The execution model and its reasoning effort, edited from the conversation
 * footer. When the selected model offers reasoning, the reader chooses its level;
 * the UI never offers an off state.
 */
export function ExecutionPicker() {
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  const draft = config.draft;

  if (draft === undefined) return null;

  const { providerId, model } = draft.models.execution;
  const effort = draft.models.execution.effort;
  const efforts = modelEfforts(draft, providerId, model).filter(
    (value) => value !== 'none',
  );
  const groups = modelGroups(draft);
  const hasChoices = groups.some((group) => group.choices.length > 0);
  const effortName =
    efforts.length === 0 ? 'Unavailable' : effortLabel(effort ?? 'none');
  const effortChoices = efforts.map((value) => ({
    label: effortLabel(value),
    value,
    // The level the model's own catalog names as its default is marked as such,
    // so a reader knows which one the model asks for when nothing chooses.
    ...(value === modelDefaultEffort(draft, providerId, model)
      ? { note: '(default)' }
      : {}),
  }));
  const selectEffort = (value: string): void => {
    config.setDraft(setExecutionEffort(draft, value as ReasoningEffort));
  };

  return (
    <div className="flex items-center gap-1">
      {config.error !== undefined && (
        <span className="text-destructive" role="alert">
          {config.error}
        </span>
      )}
      {hasChoices ? (
        <ModelPicker
          ariaLabel="Execution model"
          groups={groups}
          label={model === '' ? 'Choose model' : model}
          value={modelChoiceKey(providerId, model)}
          onSelect={(key) => config.setDraft(selectModelChoice(draft, key))}
          reasoning={{
            choices: effortChoices,
            label: effortName,
            onSelect: selectEffort,
            value: effort,
          }}
        />
      ) : (
        <Input
          aria-label="Execution model"
          autoComplete="off"
          className="w-48 border-transparent bg-transparent shadow-none hover:bg-muted focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          placeholder="Model id"
          value={model}
          onChange={(event) =>
            config.setDraft(updateModel(draft, { model: event.target.value }))
          }
        />
      )}
      <span aria-hidden="true" className="text-muted-foreground">
        ●
      </span>
      <EffortPicker
        ariaLabel="Reasoning effort"
        choices={effortChoices}
        disabled={effortChoices.length === 0}
        label={effortName}
        value={effort}
        onSelect={selectEffort}
      />
    </div>
  );
}
