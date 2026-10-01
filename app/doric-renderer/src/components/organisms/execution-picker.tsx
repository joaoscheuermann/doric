import { ChoiceCombobox } from '@/components/molecules/choice-combobox';
import { ToolbarDivider } from '@/components/molecules/toolbar-divider';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  type Configuration,
  effortLabel,
  modelChoiceKey,
  modelEfforts,
  providerLabel,
  type ReasoningEffort,
  selectModelChoice,
  setExecutionEffort,
  updateModel,
} from '@/domain/config';
import { useConfig } from '@/hooks/use-config';
import { useProviderKinds } from '@/hooks/use-provider-kinds';
import { BrainIcon } from 'lucide-react';

/** The level thinking turns on at when the model names no preferred one. */
const defaultEffort: ReasoningEffort = 'medium';

/**
 * The models every configured provider lists, as one set of choices. The choice
 * names the model alone, so the field stays as narrow as the id it holds; the
 * provider travels as the choice's detail, drawn in the list, which is what tells
 * two providers offering one model id apart.
 *
 * A model that no provider lists is still shown, first, so the surface never
 * hides the value it is set to: the profile keeps a model the catalog does not
 * describe, and the combobox says so rather than reading as empty.
 */
const modelChoices = (
  configuration: Configuration,
): {
  readonly detail?: string;
  readonly label: string;
  readonly value: string;
}[] => {
  const { providerId, model } = configuration.models.execution;
  // One provider needs no naming: its models are the only ones there are.
  const single = configuration.providers.length === 1;
  const providerOf = (id: string): string | undefined => {
    const index = configuration.providers.findIndex(
      (provider) => provider.id === id,
    );
    const provider = configuration.providers[index];

    return single || provider === undefined
      ? undefined
      : providerLabel(provider, index);
  };
  const listed = configuration.providers.flatMap((provider) =>
    (provider.models ?? []).map((entry) => ({
      detail: providerOf(provider.id),
      label: entry.name,
      value: modelChoiceKey(provider.id, entry.name),
    })),
  );
  const current = modelChoiceKey(providerId, model);

  return model === '' || listed.some((choice) => choice.value === current)
    ? listed
    : [
        { detail: providerOf(providerId), label: model, value: current },
        ...listed,
      ];
};

/**
 * What runs a prompt, chosen where the prompt is written: whether to think, how
 * hard, and the model it runs on. The footer edits the one execution profile the
 * host owns, so a choice here is the same value the Execution settings section
 * holds, and a valid change saves itself the same way.
 *
 * Thinking is a toggle: on sends the level the endpoint accepts, off sends no
 * reasoning block at all, and a model that lists no effort has nothing to toggle.
 * The marks read in the order a reader settles them — think, then how hard, then
 * with what — divided by rules, from least to most specific.
 */
export function ExecutionPicker() {
  const kinds = useProviderKinds();
  const config = useConfig(true, kinds.list);
  const draft = config.draft;

  if (draft === undefined) return null;

  const { providerId, model } = draft.models.execution;
  const effort = draft.models.execution.effort;
  const efforts = modelEfforts(draft, providerId, model);
  const choices = modelChoices(draft);
  const thinking = effort !== undefined && effort !== 'none';

  /**
   * Turns thinking on at a level the model accepts, or off. A model that lists no
   * effort cannot be told one, so it has nothing to turn on.
   */
  const setThinking = (on: boolean): void => {
    const level = on
      ? (efforts.find((value) => value !== 'none') ?? defaultEffort)
      : undefined;
    config.setDraft(setExecutionEffort(draft, level));
  };

  return (
    <div className="flex items-center gap-2">
      {config.error !== undefined && (
        <span className="text-destructive" role="alert">
          {config.error}
        </span>
      )}
      <Toggle
        aria-label="Thinking"
        size="sm"
        className="shrink-0 px-0! text-muted-foreground hover:text-foreground data-[state=on]:bg-transparent! data-[state=on]:text-foreground"
        disabled={!thinking && efforts.length === 0}
        pressed={thinking}
        onPressedChange={setThinking}
      >
        <BrainIcon />
      </Toggle>
      <ToolbarDivider />
      <ChoiceCombobox
        ariaLabel="Reasoning effort"
        disabled={efforts.length === 0}
        placeholder="None"
        choices={efforts.map((value) => ({
          label: effortLabel(value),
          value,
        }))}
        value={effort}
        onSelect={(value) =>
          config.setDraft(setExecutionEffort(draft, value as ReasoningEffort))
        }
      />
      <ToolbarDivider />
      {choices.length === 0 ? (
        <Input
          aria-label="Execution model"
          autoComplete="off"
          className="h-7 w-48 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-muted focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
          placeholder="Model id"
          value={model}
          onChange={(event) =>
            config.setDraft(updateModel(draft, { model: event.target.value }))
          }
        />
      ) : (
        <ChoiceCombobox
          ariaLabel="Execution model"
          className="max-w-72"
          placeholder="Choose model"
          choices={choices}
          value={modelChoiceKey(providerId, model)}
          onSelect={(key) => config.setDraft(selectModelChoice(draft, key))}
        />
      )}
    </div>
  );
}
