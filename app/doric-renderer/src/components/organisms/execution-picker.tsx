import { EffortPicker } from '@/components/molecules/effort-picker';
import { ModelPicker } from '@/components/molecules/model-picker';
import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  effortLabel,
  modelChoiceKey,
  modelDefaultEffort,
  modelEfforts,
  modelGroups,
  modelMandatory,
  modelThinkingEffort,
  modelThinks,
  type ReasoningEffort,
  selectModelChoice,
  setExecutionEffort,
  updateModel,
} from '@/domain/config';
import { useConfig } from '@/hooks/use-config';
import { useProviderKinds } from '@/hooks/use-provider-kinds';
import { BrainIcon } from 'lucide-react';

/**
 * What runs a prompt, chosen where the prompt is written: whether to think, how
 * hard, and the model it runs on. The footer edits the one execution profile the
 * host owns, so a choice here is the same value the Execution settings section
 * holds, and a valid change saves itself the same way.
 *
 * Thinking is a toggle wearing the brain mark alone, which its label names: on
 * sends the effort the model starts at, off sends `none`, and a model with no
 * effort to think at — or one whose catalog pins reasoning on — has the control
 * disabled rather than offering a state it cannot reach. The mark carries that
 * state on its own — a muted brain at rest, one filled in the surface's own
 * foreground when thinking is on — with the hover wash as its only chrome. The
 * marks read in the order a reader settles them — think, then with what, then
 * how hard — divided by a rule after thinking and a dot between the two choices.
 */
export function ExecutionPicker() {
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  const draft = config.draft;

  if (draft === undefined) return null;

  const { providerId, model } = draft.models.execution;
  const effort = draft.models.execution.effort;
  const efforts = modelEfforts(draft, providerId, model);
  const groups = modelGroups(draft);
  const hasChoices = groups.some((group) => group.choices.length > 0);
  // A model with no effort to think at, and one whose catalog pins reasoning on,
  // have nothing the control could change, so it reads as unavailable rather than
  // offering a choice the model cannot honor.
  const thinks = modelThinks(draft, providerId, model);
  const mandatory = modelMandatory(draft, providerId, model);
  const thinking = effort !== undefined && effort !== 'none';
  // A missing effort wears the dash of a placeholder where a reader sees the
  // label, while the names below keep saying what the dash stands for.
  const effortName =
    effort === undefined || effort === 'none' ? 'None' : effortLabel(effort);
  const effortSpoken =
    effort === undefined || effort === 'none'
      ? 'no effort'
      : effortLabel(effort);
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

  /**
   * Turns thinking on at the effort the model starts at, or off: a model that
   * cannot be turned off never reaches here, because the control is disabled.
   */
  const setThinking = (on: boolean): void => {
    config.setDraft(
      setExecutionEffort(
        draft,
        on ? modelThinkingEffort(draft, providerId, model) : 'none',
      ),
    );
  };

  return (
    <div className="flex items-center gap-1">
      {config.error !== undefined && (
        <span className="text-destructive" role="alert">
          {config.error}
        </span>
      )}
      <Toggle
        aria-label="Thinking"
        size="sm"
        className="data-[state=on]:bg-transparent aria-pressed:bg-transparent"
        disabled={!thinks}
        pressed={thinking || mandatory}
        onPressedChange={setThinking}
      >
        <BrainIcon className="text-muted-foreground group-data-[state=on]/toggle:stroke-white group-data-[state=on]/toggle:text-foreground" />
      </Toggle>
      <ToolbarDivider />
      {hasChoices ? (
        <ModelPicker
          ariaLabel="Execution model"
          groups={groups}
          label={model === '' ? 'Choose model' : model}
          value={modelChoiceKey(providerId, model)}
          onSelect={(key) => config.setDraft(selectModelChoice(draft, key))}
          reasoning={
            effortChoices.length === 0
              ? undefined
              : {
                  ariaLabel: `Reasoning, ${effortSpoken}`,
                  choices: effortChoices,
                  label: effortName,
                  value: effort,
                  onSelect: selectEffort,
                }
          }
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
