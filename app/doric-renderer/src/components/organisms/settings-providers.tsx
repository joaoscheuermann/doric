import { ProviderListEditor } from '@/components/molecules/provider-list-editor';
import { RowActions } from '@/components/molecules/row-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  type Credential,
  credentialLabel,
  credentialsOfKind,
  effortLabel,
  emptyProviderDraft,
  kindOf,
  providerAddress,
  type ProviderDraft,
  providerDraftOf,
  type ProviderField,
  providerFromDraft,
  providerIssue,
  type ProviderKind,
  providerLabel,
  type ProviderListId,
  type ProviderRow,
  providerRows,
  type ReasoningEffort,
  reasoningEfforts,
  removeProvider,
  replaceProvider,
} from '@/domain/config';
import {
  type Column,
  columnFilteringFeature,
  type ColumnFiltersState,
  columnVisibilityFeature,
  type ColumnVisibilityState,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  type SortingState,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import {
  AlertCircleIcon,
  ArrowUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * The behaviour the table opts into. TanStack Table v9 is feature-based: a
 * table keeps only what it declares here, so the sorting, filtering, visibility
 * and pagination it uses are each named, along with the sort and filter
 * functions the columns below ask for by name. Rows are not selectable: an
 * action names the row it was drawn for, so nothing has to be ticked first.
 */
const features = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric },
  // Type-only: it names the title each column carries, so the header a person
  // reads and the entry in the visibility menu are one word, not two spellings
  // of it. The value is a phantom; the library strips it at construction.
  columnMeta: {} as { title: string },
});

/** Which behaviour the columns and the table instance below are typed against. */
type DataTableFeatures = typeof features;

/** The provider columns, typed against the features and the row above. */
const columnHelper = createColumnHelper<DataTableFeatures, ProviderRow>();

/** How many rows a page holds, in the order the control offers them. */
const pageSizes = [10, 20, 50];

type SettingsProvidersProps = {
  readonly draft: Configuration;
  /** The host's provider catalog, which says what every field and list is. */
  readonly kinds: readonly ProviderKind[];
  readonly onChange: (next: Configuration) => void;
  /** The stored credentials, of which a provider's secret fields name one. */
  readonly credentials: readonly Credential[];
};

/** What each list the catalog declares is called, in a heading and its control. */
const listTitle: Record<ProviderListId, string> = {
  models: 'Models',
  reasonings: 'Reasonings',
};

const listAddLabel: Record<ProviderListId, string> = {
  models: 'Add model',
  reasonings: 'Add reasoning effort',
};

/** What a column is called, in its header and in the visibility menu alike. */
const columnTitle = <TValue,>(
  column: Column<DataTableFeatures, ProviderRow, TValue>,
): string => column.columnDef.meta?.title ?? column.id;

/** How many entries of one list a row draws, or `—` for a kind that keeps none. */
const listCountLabel = (row: ProviderRow, list: ProviderListId): string =>
  row.kind?.lists.includes(list) === true
    ? String(row.provider[list]?.length ?? 0)
    : '—';

/**
 * A column header that sorts, naming the column in both of its spellings. It is
 * generic over the column's value because a column may be keyed by a union, and
 * the header only ever reads the column's title.
 */
function SortHeader<TValue>({
  column,
}: {
  readonly column: Column<DataTableFeatures, ProviderRow, TValue>;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2"
      onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
    >
      {columnTitle(column)}
      <ArrowUpDownIcon data-icon="inline-end" />
    </Button>
  );
}

/**
 * The provider table as the one shape both the screen and the dialog draw: a
 * described column, a draggable header and a footer that pages it. Nothing here
 * is editable in place any more, so the row's identity is the provider's position
 * in the list and an action always names the provider it was drawn for.
 */
function ProviderTable({
  loading,
  onEdit,
  onRemove,
  providers,
}: {
  readonly loading: boolean;
  readonly onEdit: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly providers: readonly ProviderRow[];
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>({});

  const data = providers;

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((row) => row.provider.id, {
          id: 'id',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate font-medium">
              {providerLabel(row.original.provider, row.original.index)}
            </span>
          ),
          filterFn: 'includesString',
          sortFn: 'alphanumeric',
          meta: { title: 'Id' },
        }),
        columnHelper.accessor((row) => row.kind?.label ?? row.provider.kind, {
          id: 'kind',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate text-muted-foreground">
              {row.original.kind?.label ?? row.original.provider.kind}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Kind' },
        }),
        columnHelper.accessor(
          (row) => providerAddress(row.kind, row.provider),
          {
            id: 'address',
            header: ({ column }) => <SortHeader column={column} />,
            cell: ({ row }) => (
              <span className="truncate text-muted-foreground">
                {providerAddress(row.original.kind, row.original.provider)}
              </span>
            ),
            sortFn: 'alphanumeric',
            meta: { title: 'Address' },
          },
        ),
        columnHelper.accessor((row) => listCountLabel(row, 'models'), {
          id: 'models',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate text-muted-foreground">
              {listCountLabel(row.original, 'models')}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Models' },
        }),
        columnHelper.accessor((row) => listCountLabel(row, 'reasonings'), {
          id: 'reasonings',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate text-muted-foreground">
              {listCountLabel(row.original, 'reasonings')}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Reasonings' },
        }),
        columnHelper.display({
          id: 'actions',
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => (
            // The row opens the provider it draws, so the menu has to keep its
            // own clicks to itself: without this, opening Delete would also open
            // the dialog behind it.
            <div
              className="flex justify-end"
              onClick={(event) => event.stopPropagation()}
            >
              <RowActions
                label={providerLabel(row.original.provider, row.original.index)}
                actions={[
                  {
                    label: 'Edit',
                    icon: <PencilIcon />,
                    onSelect: () => onEdit(row.original.index),
                  },
                  {
                    label: 'Remove provider',
                    destructive: true,
                    icon: <TrashIcon />,
                    onSelect: () => onRemove(row.original.index),
                  },
                ]}
              />
            </div>
          ),
          enableHiding: false,
          enableSorting: false,
          meta: { title: 'Actions' },
        }),
      ]),
    [onEdit, onRemove],
  );

  const table = useTable({
    features,
    columns,
    data,
    // The row id is the provider's position in the list, which is the identity
    // every action addresses a row by. A provider carries no identity of its own
    // until its id is typed, and a row being typed may carry a duplicate, so an
    // id would address two rows at once.
    getRowId: (row) => String(row.index),
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    state: { columnFilters, columnVisibility, sorting },
  });

  const idFilter = table.getColumn('id')?.getFilterValue();
  const pageCount = Math.max(1, table.getPageCount());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter providers by id"
          placeholder="Filter ids…"
          className="max-w-sm"
          value={typeof idFilter === 'string' ? idFilter : ''}
          onChange={(event) =>
            table.getColumn('id')?.setFilterValue(event.target.value)
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto">
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              {table
                .getAllColumns()
                .filter((column) => column.getCanHide())
                .map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.getIsVisible()}
                    onCheckedChange={(value) =>
                      column.toggleVisibility(!!value)
                    }
                  >
                    {columnTitle(column)}
                  </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {loading
                    ? 'Reading the configured providers…'
                    : data.length === 0
                      ? 'No providers yet. Add one below.'
                      : 'No provider matches that id.'}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => onEdit(row.original.index)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex-1 text-xs text-muted-foreground">
          Page {table.state.pagination.pageIndex + 1} of {pageCount}
        </p>
        <div className="flex items-center gap-2">
          <Select
            value={String(table.state.pagination.pageSize)}
            onValueChange={(value) => table.setPageSize(Number(value))}
          >
            <SelectTrigger
              size="sm"
              aria-label="Rows per page"
              className="w-fit"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {pageSizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} rows
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="First page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.firstPage()}
          >
            <ChevronsLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRightIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Last page"
            disabled={!table.getCanNextPage()}
            onClick={() => table.lastPage()}
          >
            <ChevronsRightIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

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
        <Select value={value} onValueChange={onChange}>
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
    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Select
          value={value}
          onValueChange={onChange}
          disabled={tokens.length === 0}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose a credential" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {tokens.map((token) => (
                <SelectItem key={token.id} value={token.id}>
                  {credentialLabel(token)}
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
 * The form that adds or edits one provider, in a dialog. The id is the host's own;
 * the kind is chosen once, when the provider is added, because it fixes the field
 * set and the lists and a stored provider cannot change shape; and every field and
 * list below is the kind's, drawn in the order the catalog declares them.
 *
 * A provider is patched by the position it holds in `Configuration.providers`,
 * and the list position is what `draft.index` carries: `undefined` is the
 * provider being added, which is addressed as the row appended to the list.
 */
function ProviderDialog({
  credentials,
  draft,
  kinds,
  onChange,
  onClose,
  onSave,
}: {
  readonly credentials: readonly Credential[];
  readonly draft: ProviderDraft;
  readonly kinds: readonly ProviderKind[];
  readonly onChange: (next: ProviderDraft) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
}) {
  const editing = draft.index !== undefined;
  const kind = kindOf(kinds, draft.kind);
  const issue =
    kind === undefined
      ? 'Choose a provider kind.'
      : providerIssue(draft, kind, credentials);
  const tokens = credentialsOfKind(credentials, 'API_TOKEN');

  const setValue = (key: string, value: string): void =>
    onChange({
      ...draft,
      configuration: { ...draft.configuration, [key]: value },
    });

  const setList = (list: ProviderListId, entries: readonly string[]): void =>
    onChange(
      list === 'models'
        ? { ...draft, models: entries }
        : { ...draft, reasonings: entries },
    );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit provider' : 'Add provider'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change where this provider is called and how it authenticates.'
              : 'A provider the agent may call, and how it authenticates.'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {editing ? (
            <Field>
              <FieldLabel>Kind</FieldLabel>
              <p className="text-sm">{kind?.label ?? draft.kind}</p>
              {kind !== undefined && (
                <FieldDescription>{kind.description}</FieldDescription>
              )}
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="provider-kind">Kind</FieldLabel>
              <Select
                value={draft.kind}
                onValueChange={(value) => {
                  const chosen = kindOf(kinds, value);
                  // A field set is the kind's, so changing kind starts over: no
                  // value typed for one kind's fields survives into another's.
                  if (chosen !== undefined)
                    onChange(emptyProviderDraft(chosen));
                }}
              >
                <SelectTrigger id="provider-kind" className="w-full">
                  <SelectValue placeholder="Choose a kind" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {kinds.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {kind !== undefined && (
                <FieldDescription>{kind.description}</FieldDescription>
              )}
            </Field>
          )}

          <Field>
            <FieldLabel htmlFor="provider-id">Id</FieldLabel>
            <Input
              id="provider-id"
              autoComplete="off"
              value={draft.id}
              onChange={(event) =>
                onChange({ ...draft, id: event.target.value })
              }
            />
            <FieldDescription>
              How this provider is named in the execution settings and in
              Projects.
            </FieldDescription>
          </Field>

          {kind?.fields.map((field) => (
            <ProviderFieldControl
              key={field.key}
              field={field}
              tokens={tokens}
              value={draft.configuration[field.key] ?? ''}
              onChange={(value) => setValue(field.key, value)}
            />
          ))}

          {kind?.lists.map((list) => (
            <ProviderListEditor
              key={list}
              label={listTitle[list]}
              addLabel={listAddLabel[list]}
              entries={draft[list] ?? []}
              choices={list === 'reasonings' ? reasoningEfforts : undefined}
              choiceLabel={
                list === 'reasonings'
                  ? (value) => effortLabel(value as ReasoningEffort)
                  : undefined
              }
              onChange={(entries) => setList(list, entries)}
            />
          ))}

          {issue !== undefined && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>This provider cannot be saved yet</AlertTitle>
              <AlertDescription>{issue}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={issue !== undefined} onClick={onSave}>
            {editing ? 'Save provider' : 'Add provider'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The providers the host may call, as a data table: each row names one, the kind
 * it is, the address that kind calls, and how many models and reasonings it
 * keeps, and the actions open the dialog that edits the row or remove it. Nothing
 * is editable in place, so the table cannot carry a half-typed draft, and a row
 * that would be refused at the dialog stays as the host last stored it.
 *
 * The table's control — sorting, filtering, visibility and paging — is view state
 * that never leaves this component. A dialog's draft is the only thing that
 * becomes configuration, and it is applied to the list at one position through
 * `providerRows`, so the order the table draws rows in never decides which
 * provider is edited. The dialog does not own when it is saved: it edits the
 * configuration through `onChange`, and the section's own debounce writes it,
 * the same as every other control in this window.
 */
export function SettingsProviders({
  credentials,
  draft,
  kinds,
  onChange,
}: SettingsProvidersProps) {
  const [editing, setEditing] = useState<ProviderDraft>();
  const providers = useMemo(() => providerRows(draft, kinds), [draft, kinds]);

  /**
   * Writes the dialog's draft into the list and closes it. An added provider is
   * the row appended to the list, and an edited one keeps the position it was
   * opened at, so the execution model's reference moves with a rename either way.
   */
  const save = (): void => {
    if (editing === undefined) return;
    const kind = kindOf(kinds, editing.kind);
    if (
      kind === undefined ||
      providerIssue(editing, kind, credentials) !== undefined
    )
      return;
    const provider = providerFromDraft(editing, kind);
    const at = editing.index;
    const next =
      at === undefined
        ? addProvider(draft, provider)
        : replaceProvider(draft, at, provider);
    onChange(next);
    setEditing(undefined);
  };

  return (
    <FieldGroup>
      {kinds.length === 0 && (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>No provider kind is available</AlertTitle>
          <AlertDescription>
            The host has not declared any provider kind, so none can be added.
          </AlertDescription>
        </Alert>
      )}

      {credentialsOfKind(credentials, 'API_TOKEN').length === 0 && (
        <Alert>
          <AlertCircleIcon />
          <AlertTitle>No API token is stored yet</AlertTitle>
          <AlertDescription>
            Add an API token under Credentials before a provider can be chosen.
          </AlertDescription>
        </Alert>
      )}

      <ProviderTable
        loading={false}
        providers={providers}
        onEdit={(index) => setEditing(providerDraftOf(draft, index))}
        onRemove={(index) => onChange(removeProvider(draft, index))}
      />

      <Separator />

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={kinds.length === 0}
        onClick={() => {
          const first = kinds[0];
          if (first !== undefined) setEditing(emptyProviderDraft(first));
        }}
      >
        <PlusIcon data-icon="inline-start" />
        Add provider
      </Button>

      {editing !== undefined && (
        <ProviderDialog
          credentials={credentials}
          draft={editing}
          kinds={kinds}
          onChange={setEditing}
          onClose={() => setEditing(undefined)}
          onSave={save}
        />
      )}
    </FieldGroup>
  );
}
