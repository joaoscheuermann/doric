import { Button } from 'desktop/ui/button';
import { Field, FieldDescription, FieldLabel } from 'desktop/ui/field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'desktop/ui/table';
import { RefreshCwIcon } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import {
  catalogProviderModels,
  effortLabel,
  isReasoningEffort,
  isSameCatalogModels,
  type ProviderDraft,
  type ProviderKind,
  type ProviderModel,
  providerValues,
} from '../../domain/config.js';
import { useProviderCatalog } from '../../hooks/use-provider-catalog.js';

/**
 * The models of a provider whose model list is its live catalog
 * (`modelsFromCatalog`): nothing is chosen or typed here. The list is read
 * from the provider's own catalog once it can authenticate, written into the
 * draft as the host's fill would write it — so the execution section offers
 * the models at once — and shown read-only, with a reload for a catalog that
 * changed.
 */
export function ProviderCatalogModels({
  draft,
  kind,
  onChange,
}: {
  readonly draft: ProviderDraft;
  readonly kind: ProviderKind;
  readonly onChange: (next: ProviderDraft) => void;
}) {
  const secret = kind.fields.find((field) => field.kind === 'secret');
  const credential =
    secret === undefined ? '' : (draft.configuration[secret.key] ?? '').trim();
  const models = draft.models ?? [];

  return (
    <Field>
      <FieldLabel>Models</FieldLabel>
      {secret !== undefined && credential === '' ? (
        <FieldDescription>
          The models this provider serves appear here once it is signed in; none
          is added by hand.
        </FieldDescription>
      ) : (
        // Keyed by the credential, so a sign-in that names a new one reads
        // the catalog again with it.
        <CatalogModelsRead
          key={credential}
          draft={draft}
          kind={kind}
          models={models}
          onChange={onChange}
        />
      )}
    </Field>
  );
}

function CatalogModelsRead({
  draft,
  kind,
  models,
  onChange,
}: {
  readonly draft: ProviderDraft;
  readonly kind: ProviderKind;
  readonly models: readonly ProviderModel[];
  readonly onChange: (next: ProviderDraft) => void;
}) {
  const catalog = useProviderCatalog(providerValues(draft, kind));
  const read = useMemo(
    () =>
      catalog.loading || catalog.error !== undefined
        ? undefined
        : catalogProviderModels(catalog.models, kind),
    [catalog.loading, catalog.error, catalog.models, kind],
  );

  // A read that lists models other than the draft's becomes the draft's list,
  // exactly as the host's fill writes it on the next save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the write follows a finished read; `draft` and `onChange` change on every render and would write again for nothing.
  useEffect(() => {
    if (read === undefined || read.length === 0) return;
    if (isSameCatalogModels(read, models)) return;
    onChange({ ...draft, models: read });
  }, [read, models]);

  return (
    <>
      {catalog.error !== undefined ? (
        <FieldDescription className="text-destructive">
          The models could not be read: {catalog.error}
        </FieldDescription>
      ) : models.length === 0 ? (
        <FieldDescription>
          {catalog.loading
            ? 'Reading the models this provider serves…'
            : 'The catalog lists no models for this login.'}
        </FieldDescription>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Model</TableHead>
              <TableHead>Efforts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => (
              <TableRow key={model.name}>
                <TableCell className="font-mono text-xs">
                  {model.name}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {effortsText(model)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={catalog.loading}
          onClick={() => catalog.reload()}
        >
          <RefreshCwIcon data-icon="inline-start" />
          Reload models
        </Button>
      </div>
      <FieldDescription>
        Every model the provider's catalog lists is offered, with the efforts it
        accepts; the list follows the catalog on every save.
      </FieldDescription>
    </>
  );
}

/** A model's efforts as one line, its default marked; none when it takes none. */
const effortsText = (model: ProviderModel): string => {
  const efforts = (model.reasonings ?? []).filter(isReasoningEffort);
  if (efforts.length === 0) return 'None';
  return efforts
    .map((effort) =>
      effort === model.defaultEffort
        ? `${effortLabel(effort)} (default)`
        : effortLabel(effort),
    )
    .join(', ');
};
