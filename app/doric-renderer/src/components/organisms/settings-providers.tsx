import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  addProvider,
  type Configuration,
  type ProviderConfiguration,
  providerLabel,
  removeProvider,
  updateProvider,
} from '@/domain/config';
import { PlusIcon, TrashIcon } from 'lucide-react';

type SettingsProvidersProps = {
  readonly draft: Configuration;
  readonly onChange: (next: Configuration) => void;
};

type ProviderRowProps = {
  readonly index: number;
  readonly onPatch: (patch: Partial<ProviderConfiguration>) => void;
  readonly onRemove: () => void;
  readonly provider: ProviderConfiguration;
};

/**
 * One provider, edited in place. Credentials never travel through here: a row
 * names the environment variable that holds the key, not the key itself.
 */
function ProviderRow({ index, onPatch, onRemove, provider }: ProviderRowProps) {
  const name = providerLabel(provider, index);
  const id = (field: string) => `provider-${index}-${field}`;

  return (
    <Field>
      <div className="flex w-full items-center justify-between gap-2">
        <FieldTitle>{name}</FieldTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <TrashIcon />
        </Button>
      </div>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor={id('id')}>Id</FieldLabel>
          <Input
            id={id('id')}
            value={provider.id}
            onChange={(event) => onPatch({ id: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={id('base-url')}>Base URL</FieldLabel>
          <Input
            id={id('base-url')}
            value={provider.baseUrl}
            onChange={(event) => onPatch({ baseUrl: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={id('api-key-env')}>
            API key environment
          </FieldLabel>
          <Input
            id={id('api-key-env')}
            value={provider.apiKeyEnv}
            onChange={(event) => onPatch({ apiKeyEnv: event.target.value })}
          />
          <FieldDescription>
            The variable Doric reads the key from, such as OPENAI_API_KEY.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </Field>
  );
}

/**
 * The providers the host may call. Each row is patched by position and removed
 * by id; the domain owns what each edit does to the configuration.
 */
export function SettingsProviders({ draft, onChange }: SettingsProvidersProps) {
  return (
    <FieldGroup>
      <FieldDescription>
        Every provider Doric may call. A row names the environment variable that
        holds its API key, so no credential is stored in this configuration.
      </FieldDescription>
      {draft.providers.map((provider, index) => (
        <ProviderRow
          key={index}
          index={index}
          provider={provider}
          onPatch={(patch) => onChange(updateProvider(draft, index, patch))}
          onRemove={() => onChange(removeProvider(draft, provider.id))}
        />
      ))}
      <Separator />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange(addProvider(draft))}
      >
        <PlusIcon data-icon="inline-start" />
        Add provider
      </Button>
    </FieldGroup>
  );
}
