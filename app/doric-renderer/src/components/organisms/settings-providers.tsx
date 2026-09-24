import { Button } from '@/components/ui/button';
import { FieldDescription, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
 * One provider as a table row, edited in place. Credentials never travel
 * through here: a cell names the environment variable that holds the key, not
 * the key itself.
 */
function ProviderRow({ index, onPatch, onRemove, provider }: ProviderRowProps) {
  const name = providerLabel(provider, index);

  return (
    <TableRow>
      <TableCell>
        <Input
          aria-label={`Id for ${name}`}
          value={provider.id}
          onChange={(event) => onPatch({ id: event.target.value })}
        />
      </TableCell>
      <TableCell>
        <Input
          aria-label={`Base URL for ${name}`}
          value={provider.baseUrl}
          onChange={(event) => onPatch({ baseUrl: event.target.value })}
        />
      </TableCell>
      <TableCell>
        <Input
          aria-label={`API key environment for ${name}`}
          value={provider.apiKeyEnv}
          onChange={(event) => onPatch({ apiKeyEnv: event.target.value })}
        />
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <TrashIcon />
        </Button>
      </TableCell>
    </TableRow>
  );
}

/**
 * The providers the host may call, as an editable table. Each row is patched
 * and removed by position, which is the only identity a row has before its id
 * is typed; the domain owns what each edit does to the configuration.
 *
 * The table is the vendored `Table` primitive, not the TanStack-backed
 * data-table stack: this list is a handful of rows with no sorting, filtering
 * or pagination, so TanStack would add a runtime dependency to the Electron
 * bundle for nothing. Interactive columns are the reason to reach for it.
 */
export function SettingsProviders({ draft, onChange }: SettingsProvidersProps) {
  return (
    <FieldGroup>
      <FieldDescription>
        Every provider Doric may call. A row names the environment variable that
        holds its API key, so no credential is stored in this configuration.
      </FieldDescription>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Id</TableHead>
            <TableHead>Base URL</TableHead>
            <TableHead>API key environment</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {draft.providers.map((provider, index) => (
            <ProviderRow
              key={index}
              index={index}
              provider={provider}
              onPatch={(patch) => onChange(updateProvider(draft, index, patch))}
              onRemove={() => onChange(removeProvider(draft, index))}
            />
          ))}
        </TableBody>
      </Table>
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
