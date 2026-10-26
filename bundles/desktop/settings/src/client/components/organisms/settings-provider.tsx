import { Alert, AlertDescription, AlertTitle } from 'desktop/ui/alert';
import { Button } from 'desktop/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from 'desktop/ui/combobox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from 'desktop/ui/field';
import { Input } from 'desktop/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'desktop/ui/select';
import { AlertCircleIcon, ChevronRightIcon, LogInIcon } from 'lucide-react';

import {
  type Credential,
  credentialLabel,
  credentialsOfKind,
  emptyProviderDraft,
  kindFillsModelEfforts,
  kindOf,
  type ProviderDraft,
  type ProviderField,
  type ProviderKind,
  providerIssue,
} from '../../domain/config.js';
import type { ClaudeLogin } from '../../hooks/use-claude-login.js';
import { ProviderModelsEditor } from '../molecules/provider-models-editor.js';
import { ProviderCatalogModels } from './provider-catalog-models.js';
import { ProviderModelPicker } from './provider-model-picker.js';

/**
 * One field a kind declares, drawn the way the field says it must be: `enum`
 * offers the kind's own options, `secret` offers the stored `API_TOKEN`
 * credentials, and every other kind is typed into a field, with `url` and
 * `number` only changing how the input behaves. The label, the description and
 * the placeholder are the field's, so a kind the renderer has never seen is
 * still fully drawn — there is no per-kind case here.
 */
function ProviderFieldControl({
  field,
  onChange,
  tokens,
  value,
}: {
  readonly field: ProviderField;
  readonly onChange: (value: string) => void;
  readonly tokens: readonly Credential[];
  readonly value: string;
}) {
  const id = `provider-${field.key}`;

  if (field.kind === 'enum') {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Select
          value={value}
          onValueChange={(next) => {
            if (next !== null) onChange(next);
          }}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue
              placeholder={field.placeholder ?? `Choose ${field.label}`}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(field.options ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {field.description !== undefined && (
          <FieldDescription>{field.description}</FieldDescription>
        )}
      </Field>
    );
  }

  if (field.kind === 'secret') {
    // The trigger names the chosen credential as the list does, not by its id.
    const tokenItems = tokens.map((token) => ({
      label: credentialLabel(token),
      value: token.id,
    }));

    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Select
          items={tokenItems}
          value={value}
          onValueChange={(next) => {
            if (next !== null) onChange(next);
          }}
          disabled={tokens.length === 0}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose a credential" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {tokenItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          {tokens.length === 0
            ? 'No API token is stored yet. Add one under Credentials.'
            : (field.description ?? 'The API token this field names.')}
        </FieldDescription>
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        spellCheck={field.kind === 'url' ? false : undefined}
        inputMode={field.kind === 'number' ? 'numeric' : undefined}
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {field.description !== undefined && (
        <FieldDescription>{field.description}</FieldDescription>
      )}
    </Field>
  );
}

/**
 * The form that configures one provider, as the screen the providers list
 * navigates to. The kind fixes the field set, the model list, and which fields
 * an operator rarely needs — those wait behind the last section rather than the
 * whole form carrying them — so it is chosen here and changing it starts the
 * form over: no value typed for one kind's fields survives into another's, and
 * every field and model below is the kind's, drawn in the order the catalog
 * declares them. The provider's own id is the name it is addressed by everywhere
 * else.
 *
 * The screen owns no draft of its own: it edits the draft through `onChange`,
 * exactly as every other section does, so the window's own save carries the
 * change and no footer offers a second way to commit it. A new provider is
 * addressed as the row appended to the list, which is what `draft.index` says
 * once the screen's caller has stored it.
 */
export function SettingsProviderScreen({
  claudeLogin,
  credentials,
  draft,
  kinds,
  onChange,
}: {
  /** The Claude sign-in the `claude` kind's row offers; absent outside the settings window. */
  readonly claudeLogin?: ClaudeLogin;
  readonly credentials: readonly Credential[];
  readonly draft: ProviderDraft;
  readonly kinds: readonly ProviderKind[];
  readonly onChange: (next: ProviderDraft) => void;
}) {
  const kind = kindOf(kinds, draft.kind);
  const tokens = credentialsOfKind(credentials, 'API_TOKEN');
  // The `claude` kind's token is what its sign-in stores: while the sign-in
  // is offered, the row takes the token field's place, and the operator never
  // picks a credential by hand.
  const signInField =
    kind?.id === 'claude' && claudeLogin !== undefined
      ? kind.fields.find((field) => field.kind === 'secret')
      : undefined;
  const signedIn =
    signInField === undefined
      ? undefined
      : tokens.find(
          (token) => token.id === draft.configuration[signInField.key],
        );
  const draftIssue =
    kind === undefined
      ? 'Choose a provider kind.'
      : providerIssue(draft, kind, credentials);
  const issue =
    signInField !== undefined &&
    signedIn === undefined &&
    draft.id.trim() !== '' &&
    draftIssue !== undefined
      ? 'Sign in with Claude to finish this provider.'
      : draftIssue;

  const setValue = (key: string, value: string): void =>
    onChange({
      ...draft,
      configuration: { ...draft.configuration, [key]: value },
    });

  // A kind decides which of its fields an operator rarely needs, so the screen
  // draws the necessary ones in the open and shelves the rest behind the last
  // section: an endpoint is the kind's own until someone points it elsewhere.
  const fields = (kind?.fields ?? []).filter((field) => field !== signInField);
  const necessary = fields.filter(({ advanced }) => advanced !== true);
  const advanced = fields.filter(({ advanced }) => advanced === true);

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="provider-kind">Kind</FieldLabel>
        <Combobox
          items={kinds}
          itemToStringValue={(candidate) => candidate.label}
          value={kind ?? null}
          onValueChange={(chosen) => {
            // A field set is the kind's, so changing kind starts over: no value
            // typed for one kind's fields survives into another's.
            if (chosen !== null) onChange(emptyProviderDraft(chosen));
          }}
        >
          <ComboboxInput id="provider-kind" placeholder="Choose a kind" />
          <ComboboxContent>
            <ComboboxEmpty>No kind matches.</ComboboxEmpty>
            <ComboboxList>
              {(candidate) => (
                <ComboboxItem key={candidate.id} value={candidate}>
                  {candidate.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        {kind !== undefined && (
          <FieldDescription>{kind.description}</FieldDescription>
        )}
      </Field>

      <Field>
        <FieldLabel htmlFor="provider-name">Name</FieldLabel>
        <Input
          id="provider-name"
          autoComplete="off"
          value={draft.id}
          onChange={(event) => onChange({ ...draft, id: event.target.value })}
        />
        <FieldDescription>
          How this provider is named in the execution settings and in Projects.
        </FieldDescription>
      </Field>

      {necessary.map((field) => (
        <ProviderFieldControl
          key={field.key}
          field={field}
          tokens={tokens}
          value={draft.configuration[field.key] ?? ''}
          onChange={(value) => setValue(field.key, value)}
        />
      ))}

      {signInField !== undefined && claudeLogin !== undefined && (
        <Field>
          <FieldLabel>Claude login</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={claudeLogin.busy}
              onClick={() => claudeLogin.start()}
            >
              <LogInIcon data-icon="inline-start" />
              {claudeLogin.busy
                ? 'Waiting for the browser…'
                : signedIn === undefined
                  ? 'Sign in with Claude'
                  : 'Sign in again'}
            </Button>
            {claudeLogin.busy && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => claudeLogin.cancel()}
              >
                Cancel
              </Button>
            )}
          </div>
          <FieldDescription>
            {signedIn === undefined
              ? 'Signs in with a Claude Code subscription: the browser opens, and the login is stored as a credential this provider uses.'
              : `Signed in: this provider uses the '${signedIn.name}' credential. When Claude requests fail with an authentication error, the login expired or was revoked: sign in again.`}
          </FieldDescription>
          {claudeLogin.busy && claudeLogin.url !== undefined && (
            <FieldDescription>
              If the browser did not open, visit{' '}
              <span className="break-all select-all">{claudeLogin.url}</span>
            </FieldDescription>
          )}
        </Field>
      )}

      {kind !== undefined &&
        (kind.lists.includes('models') ? (
          kind.modelsFromCatalog === true ? (
            <ProviderCatalogModels
              draft={draft}
              kind={kind}
              onChange={onChange}
            />
          ) : kindFillsModelEfforts(kind) ? (
            <ProviderModelPicker
              draft={draft}
              kind={kind}
              onChange={onChange}
            />
          ) : (
            <ProviderModelsEditor
              draft={draft}
              kind={kind}
              onChange={onChange}
            />
          )
        ) : null)}

      {advanced.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
            <span>Advanced settings</span>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 transition-transform group-data-panel-open:rotate-90"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-4">
            {advanced.map((field) => (
              <ProviderFieldControl
                key={field.key}
                field={field}
                tokens={tokens}
                value={draft.configuration[field.key] ?? ''}
                onChange={(value) => setValue(field.key, value)}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {issue !== undefined && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>This provider cannot be saved yet</AlertTitle>
          <AlertDescription>{issue}</AlertDescription>
        </Alert>
      )}
    </FieldGroup>
  );
}
