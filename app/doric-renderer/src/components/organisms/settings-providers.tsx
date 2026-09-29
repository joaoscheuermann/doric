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
  emptyProviderDraft,
  type ProviderDraft,
  providerDraftOf,
  providerIssue,
  providerLabel,
  type ProviderRow,
  providerRows,
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
  readonly onChange: (next: Configuration) => void;
  /** The stored credentials, of which a provider may name an `API_TOKEN`. */
  readonly credentials: readonly Credential[];
};

/** What a column is called, in its header and in the visibility menu alike. */
const columnTitle = <TValue,>(
  column: Column<DataTableFeatures, ProviderRow, TValue>,
): string => column.columnDef.meta?.title ?? column.id;

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
  credentials,
  loading,
  onEdit,
  onRemove,
  providers,
}: {
  readonly credentials: readonly Credential[];
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
        columnHelper.accessor((row) => row.provider.baseUrl, {
          id: 'baseUrl',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate text-muted-foreground">
              {row.original.provider.baseUrl}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Base URL' },
        }),
        columnHelper.accessor((row) => row.provider.credentialId, {
          id: 'credentialId',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => {
            const chosen = credentials.find(
              (credential) =>
                credential.id === row.original.provider.credentialId,
            );
            return chosen === undefined ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className="truncate text-muted-foreground">
                {credentialLabel(chosen)}
              </span>
            );
          },
          sortFn: 'alphanumeric',
          meta: { title: 'Credential' },
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
    [credentials, onEdit, onRemove],
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
 * The form that adds or edits one provider, in a dialog: the id the host knows it
 * by, the base URL it is called at, and the `API_TOKEN` credential it
 * authenticates with. The credential list is exactly the stored `API_TOKEN`
 * credentials, because that is the only kind a provider may name.
 *
 * A provider is patched by the position it holds in `Configuration.providers`,
 * and the list position is what `draft.index` carries: `undefined` is the
 * provider being added, which is addressed as the row appended to the list.
 */
function ProviderDialog({
  credentials,
  draft,
  onChange,
  onClose,
  onSave,
}: {
  readonly credentials: readonly Credential[];
  readonly draft: ProviderDraft;
  readonly onChange: (next: ProviderDraft) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
}) {
  const editing = draft.index !== undefined;
  const issue = providerIssue(draft);
  const choices = credentialsOfKind(credentials, 'API_TOKEN');

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
              ? 'Change where this provider is called and which credential it authenticates with.'
              : 'A provider the agent may call, and the credential it authenticates with.'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
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

          <Field>
            <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
            <Input
              id="provider-base-url"
              autoComplete="off"
              spellCheck={false}
              value={draft.baseUrl}
              onChange={(event) =>
                onChange({ ...draft, baseUrl: event.target.value })
              }
            />
            <FieldDescription>
              The `http://` or `https://` address prompts are sent to.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="provider-credential">Credential</FieldLabel>
            <Select
              value={draft.credentialId}
              onValueChange={(value) =>
                onChange({ ...draft, credentialId: value })
              }
              disabled={choices.length === 0}
            >
              <SelectTrigger id="provider-credential" className="w-full">
                <SelectValue placeholder="Choose a credential" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {choices.map((credential) => (
                    <SelectItem key={credential.id} value={credential.id}>
                      {credentialLabel(credential)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {choices.length === 0
                ? 'No API token is stored yet. Add one under Credentials.'
                : 'The API token this provider authenticates with.'}
            </FieldDescription>
          </Field>

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
 * The providers the host may call, as a data table: each row names one, the
 * address it is called at, and the credential it authenticates with, and the
 * actions open the dialog that edits the row or remove it. Nothing is editable
 * in place, so the table cannot carry a half-typed draft, and a row that would be
 * refused at the dialog stays as the host last stored it.
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
  onChange,
}: SettingsProvidersProps) {
  const [editing, setEditing] = useState<ProviderDraft>();
  const providers = useMemo(() => providerRows(draft), [draft]);

  /**
   * Writes the dialog's draft into the list and closes it. An added provider is
   * the row appended to the list, and an edited one keeps the position it was
   * opened at, so the execution model's reference moves with a rename either way.
   */
  const save = (): void => {
    if (editing === undefined || providerIssue(editing) !== undefined) return;
    const at = editing.index;
    const next =
      at === undefined
        ? addProvider(draft, editing)
        : replaceProvider(draft, at, editing);
    onChange(next);
    setEditing(undefined);
  };

  return (
    <FieldGroup>
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
        credentials={credentials}
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
        onClick={() => setEditing(emptyProviderDraft())}
      >
        <PlusIcon data-icon="inline-start" />
        Add provider
      </Button>

      {editing !== undefined && (
        <ProviderDialog
          credentials={credentials}
          draft={editing}
          onChange={setEditing}
          onClose={() => setEditing(undefined)}
          onSave={save}
        />
      )}
    </FieldGroup>
  );
}
