import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import {
  addModel,
  effortLabel,
  type ProviderDraft,
  type ProviderKind,
  type ProviderModel,
  type ReasoningEffort,
  reasoningEfforts,
  removeModel,
} from '@/domain/config';
import { PlusIcon, TrashIcon } from 'lucide-react';

/**
 * The models a provider offers, one card per model: its name, and — when the
 * kind keeps them — the reasoning efforts that model accepts. The efforts are a
 * row of toggles rather than a nested list, because they are a small closed set
 * and which ones a model accepts is read at a glance, model by model. A model
 * that accepts none is not an error; the execution effort then falls back to the
 * whole set.
 *
 * This is the editor for a kind whose own catalog says nothing about its models:
 * a kind that reads one offers the models to choose from instead, in
 * `ProviderModelPicker`.
 */
export function ProviderModelsEditor({
  draft,
  kind,
  onChange,
}: {
  readonly draft: ProviderDraft;
  readonly kind: ProviderKind;
  readonly onChange: (next: ProviderDraft) => void;
}) {
  const models = draft.models ?? [];
  const keepsReasonings = kind.lists.includes('reasonings');

  const replace = (index: number, next: ProviderModel): void =>
    onChange({
      ...draft,
      models: models.map((model, at) => (at === index ? next : model)),
    });

  const remove = (index: number): void => {
    const current = models[index];
    if (current !== undefined)
      onChange({ ...draft, models: removeModel(models, current.name) });
  };

  const setName = (index: number, name: string): void => {
    const current = models[index];
    if (current !== undefined) replace(index, { ...current, name });
  };

  const toggleEffort = (
    index: number,
    effort: ReasoningEffort,
    pressed: boolean,
  ): void => {
    const current = models[index];
    if (current === undefined) return;
    const chosen = new Set(current.reasonings ?? []);
    if (pressed) chosen.add(effort);
    else chosen.delete(effort);
    replace(index, {
      ...current,
      reasonings: reasoningEfforts.filter((value) => chosen.has(value)),
    });
  };

  return (
    <Field>
      <FieldLabel>Models</FieldLabel>
      <div className="flex flex-col gap-2">
        {models.map((model, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-lg border p-2"
          >
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Model ${index + 1}`}
                autoComplete="off"
                placeholder="Model id"
                value={model.name}
                onChange={(event) => setName(index, event.target.value)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove model ${index + 1}`}
                onClick={() => remove(index)}
              >
                <TrashIcon />
              </Button>
            </div>
            {keepsReasonings && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="pr-1 text-xs text-muted-foreground">
                  Reasoning
                </span>
                {reasoningEfforts.map((effort) => (
                  <Toggle
                    key={effort}
                    variant="outline"
                    size="sm"
                    aria-label={`${effortLabel(effort)} for model ${index + 1}`}
                    pressed={model.reasonings?.includes(effort) ?? false}
                    onPressedChange={(pressed) =>
                      toggleEffort(index, effort, pressed)
                    }
                  >
                    {effortLabel(effort)}
                  </Toggle>
                ))}
              </div>
            )}
          </div>
        ))}
        {models.length === 0 && (
          <FieldDescription>
            No model yet. The execution model is typed by hand until one is
            added.
          </FieldDescription>
        )}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            onChange({
              ...draft,
              models: addModel(
                models,
                keepsReasonings ? { name: '', reasonings: [] } : { name: '' },
              ),
            })
          }
        >
          <PlusIcon data-icon="inline-start" />
          Add model
        </Button>
      </div>
    </Field>
  );
}
