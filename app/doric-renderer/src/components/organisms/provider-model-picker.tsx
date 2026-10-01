import { ProviderModelsTable } from '@/components/molecules/provider-models-table';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  addModel,
  type ProviderDraft,
  type ProviderKind,
  providerValues,
  removeModel,
} from '@/domain/config';
import { useProviderCatalog } from '@/hooks/use-provider-catalog';
import { ChevronRightIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';

/**
 * The models one provider offers, chosen from the catalog its endpoint serves.
 *
 * The picker is where the read happens: nothing is asked of the endpoint until an
 * operator opens it, and the reload is theirs to ask for, because the catalog
 * belongs to a connection the form is still holding. What is chosen is the
 * provider's own model list, in the order it was chosen, and that list is what
 * the execution section offers.
 */
export function ProviderModelPicker({
  draft,
  kind,
  onChange,
}: {
  readonly draft: ProviderDraft;
  readonly kind: ProviderKind;
  readonly onChange: (next: ProviderDraft) => void;
}) {
  const offered = draft.models ?? [];
  const [manual, setManual] = useState('');
  const catalog = useProviderCatalog(providerValues(draft, kind));

  const keepsReasonings = kind.lists.includes('reasonings');

  const pick = (id: string, picked: boolean): void =>
    onChange({
      ...draft,
      models: picked
        ? addModel(
            offered,
            keepsReasonings ? { name: id, reasonings: [] } : { name: id },
          )
        : removeModel(offered, id),
    });

  const addManual = (): void => {
    pick(manual.trim(), true);
    setManual('');
  };

  return (
    <Field>
      <FieldLabel>Models</FieldLabel>
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger className="group flex w-full items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <span>
            {offered.length === 0
              ? 'Choose from the catalog'
              : `${offered.length} offered`}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3">
          {catalog.error !== undefined ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-destructive">
                The endpoint could not be read: {catalog.error}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => catalog.reload()}
              >
                <RefreshCwIcon data-icon="inline-start" />
                Reload
              </Button>
            </div>
          ) : (
            <ProviderModelsTable
              catalog={catalog.models}
              loading={catalog.loading}
              offered={offered}
              onPick={pick}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Add a model the catalog does not list"
              autoComplete="off"
              className="max-w-sm"
              placeholder="Model id"
              value={manual}
              onChange={(event) => setManual(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={manual.trim() === ''}
              onClick={addManual}
            >
              <PlusIcon data-icon="inline-start" />
              Add model
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => catalog.reload()}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Reload
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <FieldDescription>
        {offered.length === 0
          ? 'The execution model is typed by hand until a model is offered here.'
          : `Offered: ${offered.map(({ name }) => name).join(', ')}`}
      </FieldDescription>
    </Field>
  );
}
