// The dialog that adds or edits one MCP server of a Project: its name, how
// Doric reaches it (an `http` URL with headers, or a `stdio` command the
// Project's sandbox runs, with its environment) and whether it runs. A header
// or variable is a literal value or a stored credential the server reads when
// it connects; "New credential…" stores a token without leaving the dialog.
//
// The draft is checked by the contract's own schema on Save: a refusal marks
// the fields to correct, and they are checked again as the reader types. A
// host failure keeps the dialog open on what the reader typed and says why in
// a toast.

import type { CredentialDescription } from 'bundle/contracts';
import { Button } from 'desktop/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from 'desktop/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import { toast } from 'desktop/ui/sonner';
import { Switch } from 'desktop/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'desktop/ui/table';
import { Textarea } from 'desktop/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from 'desktop/ui/toggle-group';
import {
  ChevronRightIcon,
  GlobeIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { McpServerView } from '../contracts/index.js';
import { failureMessage, type McpApi } from './api.js';
import {
  checkDraft,
  type DraftErrors,
  draftOf,
  type EntryDraft,
  emptyDraft,
  emptyEntry,
  type ServerDraft,
} from './draft.js';

/** The credential picker's item that opens the "New credential" dialog. */
const NEW_CREDENTIAL = 'mcp:new-credential';

interface EntryWords {
  readonly legend: string;
  readonly add: string;
  readonly remove: string;
  readonly empty: string;
  readonly description: string;
}

const headerWords: EntryWords = {
  legend: 'Headers',
  add: 'Add header',
  remove: 'Remove header',
  empty: 'No headers',
  description: 'Sent with every request to the server.',
};

const variableWords: EntryWords = {
  legend: 'Environment',
  add: 'Add variable',
  remove: 'Remove variable',
  empty: 'No variables',
  description:
    "Added to the sandbox image's environment; the command gets nothing else from the host.",
};

function EntryRow({
  entry,
  words,
  error,
  credentials,
  onChange,
  onRemove,
  onNewCredential,
}: {
  readonly entry: EntryDraft;
  readonly words: EntryWords;
  readonly error: string | undefined;
  readonly credentials: readonly CredentialDescription[];
  readonly onChange: (next: EntryDraft) => void;
  readonly onRemove: () => void;
  readonly onNewCredential: () => void;
}) {
  const items = [
    { label: 'Plain value', value: null },
    ...credentials.map((credential) => ({
      label: credential.name,
      value: credential.id,
    })),
    { label: 'New credential…', value: NEW_CREDENTIAL },
  ];

  return (
    <TableRow>
      <TableCell>
        <Input
          aria-label="Name"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          value={entry.name}
          onChange={(event) => onChange({ ...entry, name: event.target.value })}
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Select
            items={items}
            value={entry.credentialId ?? null}
            onValueChange={(value) => {
              if (value === NEW_CREDENTIAL) onNewCredential();
              else onChange({ ...entry, credentialId: value ?? undefined });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Credential"
              className={entry.credentialId === undefined ? 'w-32' : 'w-full'}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {items.map((item) => (
                  <SelectItem key={item.value ?? 'none'} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {entry.credentialId === undefined && (
            <Input
              aria-label="Value"
              autoComplete="off"
              spellCheck={false}
              value={entry.value}
              onChange={(event) =>
                onChange({ ...entry, value: event.target.value })
              }
            />
          )}
        </div>
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={words.remove}
          title={words.remove}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function Entries({
  entries,
  words,
  errors,
  credentials,
  onChange,
  onNewCredential,
}: {
  readonly entries: readonly EntryDraft[];
  readonly words: EntryWords;
  readonly errors: DraftErrors['entries'];
  readonly credentials: readonly CredentialDescription[];
  readonly onChange: (next: readonly EntryDraft[]) => void;
  readonly onNewCredential: (key: string) => void;
}) {
  return (
    <FieldSet className="gap-2">
      <FieldLegend variant="label">{words.legend}</FieldLegend>
      <FieldDescription>{words.description}</FieldDescription>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-2/5">Name</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Remove</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-16 text-center text-muted-foreground"
                >
                  {words.empty}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <EntryRow
                  key={entry.key}
                  entry={entry}
                  words={words}
                  error={errors?.[entry.key]}
                  credentials={credentials}
                  onChange={(next) =>
                    onChange(
                      entries.map((item) =>
                        item.key === entry.key ? next : item,
                      ),
                    )
                  }
                  onRemove={() =>
                    onChange(entries.filter((item) => item.key !== entry.key))
                  }
                  onNewCredential={() => onNewCredential(entry.key)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <FieldError
        errors={entries
          .flatMap((entry) => errors?.[entry.key] ?? [])
          .map((message) => ({ message }))}
      />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...entries, emptyEntry()])}
      >
        <PlusIcon data-icon="inline-start" />
        {words.add}
      </Button>
    </FieldSet>
  );
}

/** Stores a token as an `API_TOKEN` credential, then hands it back. */
function NewCredentialDialog({
  api,
  onCreated,
  onClose,
}: {
  readonly api: McpApi;
  readonly onCreated: (credential: CredentialDescription) => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = name.trim() !== '' && secret !== '' && !busy;

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      onCreated(await api.createCredential({ name: name.trim(), secret }));
    } catch (error) {
      toast.error(failureMessage(error), { id: 'mcp-credential' });
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New credential</DialogTitle>
          <DialogDescription>
            A token the host stores and never sends back. The server reads it
            when it connects.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
            <Input
              id={`${id}-name`}
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-secret`}>Secret</FieldLabel>
            <Input
              id={`${id}-secret`}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void create()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransportFields({
  draft,
  errors,
  credentials,
  onChange,
  onNewCredential,
}: {
  readonly draft: ServerDraft;
  readonly errors: DraftErrors;
  readonly credentials: readonly CredentialDescription[];
  readonly onChange: (next: ServerDraft) => void;
  readonly onNewCredential: (key: string) => void;
}) {
  const id = useId();

  if (draft.kind === 'http') {
    return (
      <>
        <Field data-invalid={errors.url !== undefined}>
          <FieldLabel htmlFor={`${id}-url`}>URL</FieldLabel>
          <Input
            id={`${id}-url`}
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://example.com/mcp"
            aria-invalid={errors.url !== undefined}
            value={draft.url}
            onChange={(event) =>
              onChange({ ...draft, url: event.target.value })
            }
          />
          {errors.url !== undefined && <FieldError>{errors.url}</FieldError>}
        </Field>
        <Entries
          entries={draft.headers}
          words={headerWords}
          errors={errors.entries}
          credentials={credentials}
          onChange={(headers) => onChange({ ...draft, headers })}
          onNewCredential={onNewCredential}
        />
      </>
    );
  }

  return (
    <>
      <Field data-invalid={errors.command !== undefined}>
        <FieldLabel htmlFor={`${id}-command`}>Command</FieldLabel>
        <Input
          id={`${id}-command`}
          autoComplete="off"
          spellCheck={false}
          placeholder="npx"
          aria-invalid={errors.command !== undefined}
          value={draft.command}
          onChange={(event) =>
            onChange({ ...draft, command: event.target.value })
          }
        />
        <FieldDescription>Run in the Project's sandbox.</FieldDescription>
        {errors.command !== undefined && (
          <FieldError>{errors.command}</FieldError>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-args`}>Arguments</FieldLabel>
        <Textarea
          id={`${id}-args`}
          spellCheck={false}
          rows={3}
          value={draft.args}
          onChange={(event) => onChange({ ...draft, args: event.target.value })}
        />
        <FieldDescription>One argument per line.</FieldDescription>
      </Field>
      <Entries
        entries={draft.env}
        words={variableWords}
        errors={errors.entries}
        credentials={credentials}
        onChange={(env) => onChange({ ...draft, env })}
        onNewCredential={onNewCredential}
      />
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
          Advanced
          <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${id}-cwd`}>Working directory</FieldLabel>
            <Input
              id={`${id}-cwd`}
              autoComplete="off"
              spellCheck={false}
              placeholder="The sandbox's default"
              value={draft.cwd}
              onChange={(event) =>
                onChange({ ...draft, cwd: event.target.value })
              }
            />
          </Field>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

/** Sets the credential of the entry `key` names, in whichever list holds it. */
const withCredential = (
  draft: ServerDraft,
  key: string,
  credentialId: string,
): ServerDraft => {
  const set = (entries: readonly EntryDraft[]) =>
    entries.map((entry) =>
      entry.key === key ? { ...entry, credentialId } : entry,
    );
  return { ...draft, headers: set(draft.headers), env: set(draft.env) };
};

/**
 * Adds a server to the Project `projectId`, or edits `server` (in its own
 * Project) when one is given. Closes once the host stored it.
 */
export function ServerDialog({
  api,
  projectId,
  server,
  onClose,
}: {
  readonly api: McpApi;
  readonly projectId: string;
  readonly server?: McpServerView;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<ServerDraft>(() =>
    server === undefined ? emptyDraft : draftOf(server),
  );
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [credentials, setCredentials] = useState<
    readonly CredentialDescription[]
  >([]);
  /** The entry a "New credential" dialog is open for. */
  const [creatingFor, setCreatingFor] = useState<string>();

  useEffect(() => {
    let current = true;
    api.credentials().then(
      (list) => {
        if (current) setCredentials(list);
      },
      (error: unknown) => {
        toast.error(failureMessage(error), { id: 'mcp-credentials' });
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  const check = checkDraft(draft);
  const errors: DraftErrors = attempted && !check.ok ? check.errors : {};

  const save = async (): Promise<void> => {
    setAttempted(true);
    if (!check.ok) return;
    setSaving(true);
    try {
      if (server === undefined) await api.create(projectId, check.input);
      else await api.update(server.projectId, server.id, check.input);
      onClose();
    } catch (error) {
      toast.error(failureMessage(error), { id: 'mcp-server-save' });
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {server === undefined ? 'Add MCP server' : 'Edit MCP server'}
          </DialogTitle>
          <DialogDescription>
            Its tools are offered to this Project's prompts.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 max-h-[65vh] overflow-y-auto px-4">
          <FieldGroup>
            <Field data-invalid={errors.name !== undefined}>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                autoComplete="off"
                aria-invalid={errors.name !== undefined}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
              {errors.name !== undefined && (
                <FieldError>{errors.name}</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel id={`${id}-transport`}>Transport</FieldLabel>
              <ToggleGroup
                variant="outline"
                size="sm"
                className="w-full"
                aria-labelledby={`${id}-transport`}
                value={[draft.kind]}
                onValueChange={([kind]) => {
                  if (kind === 'http' || kind === 'stdio') {
                    setDraft({ ...draft, kind });
                  }
                }}
              >
                <ToggleGroupItem value="http" className="flex-1">
                  <GlobeIcon data-icon="inline-start" />
                  HTTP
                </ToggleGroupItem>
                <ToggleGroupItem value="stdio" className="flex-1">
                  <TerminalIcon data-icon="inline-start" />
                  stdio
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <TransportFields
              draft={draft}
              errors={errors}
              credentials={credentials}
              onChange={setDraft}
              onNewCredential={setCreatingFor}
            />
          </FieldGroup>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center gap-2">
            <Switch
              id={`${id}-enabled`}
              checked={draft.enabled}
              onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
            />
            <FieldLabel htmlFor={`${id}-enabled`}>Enabled</FieldLabel>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </DialogFooter>

        {creatingFor !== undefined && (
          <NewCredentialDialog
            api={api}
            onClose={() => setCreatingFor(undefined)}
            onCreated={(credential) => {
              setCredentials((list) => [...list, credential]);
              setDraft((current) =>
                withCredential(current, creatingFor, credential.id),
              );
              setCreatingFor(undefined);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
