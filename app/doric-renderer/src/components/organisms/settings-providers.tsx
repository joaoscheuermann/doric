import { RowActions } from '@/components/molecules/row-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  type Configuration,
  type Credential,
  credentialsOfKind,
  providerAddress,
  type ProviderKind,
  providerLabel,
  type ProviderRow,
  providerRows,
  removeProvider,
} from '@/domain/config';
import {
  type Column,
  columnFilteringFeature,
  type ColumnFiltersState,
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
 * table keeps only what it declares here, so the sorting, filtering and
 * pagination it uses are each named, along with the sort and filter functions
 * the columns below ask for by name. Rows are not selectable: an action names
 * the row it was drawn for, so nothing has to be ticked first.
 */
const features = tableFeatures({
  columnFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric },
  // Type-only: it names the title each column carries, so the header a person
  // reads is stated once. The value is a phantom; the library strips it at
  // construction.
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
  /** Opens the screen that adds a provider of the first kind the catalog offers. */
  readonly onAdd: () => void;
  /** Opens the screen that configures the provider at one list position. */
  readonly onEdit: (index: number) => void;
};

/** What a column is called, in its header. */
const columnTitle = <TValue,>(
  column: Column<DataTableFeatures, ProviderRow, TValue>,
): string => column.columnDef.meta?.title ?? column.id;

/** How many models a row offers, or `—` for a kind that keeps none. */
const modelCountLabel = (row: ProviderRow): string =>
  row.kind?.lists.includes('models') === true
    ? String(row.provider.models?.length ?? 0)
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
 * The provider table as the one shape the section draws: a described column, a
 * sortable header and a footer that pages it. Nothing here is editable in place
 * any more, so the row's identity is the provider's position in the list and an
 * action always names the provider it was drawn for.
 */
function ProviderTable({
  addDisabled,
  loading,
  onAdd,
  onEdit,
  onRemove,
  providers,
}: {
  readonly addDisabled: boolean;
  readonly loading: boolean;
  readonly onAdd: () => void;
  readonly onEdit: (index: number) => void;
  readonly onRemove: (index: number) => void;
  readonly providers: readonly ProviderRow[];
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

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
          meta: { title: 'Name' },
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
        columnHelper.accessor((row) => modelCountLabel(row), {
          id: 'models',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate text-muted-foreground">
              {modelCountLabel(row.original)}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Models' },
        }),
        columnHelper.display({
          id: 'actions',
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => (
            // The row opens the provider it draws, so the menu has to keep its
            // own clicks to itself: without this, opening Delete would also open
            // the configuration screen behind it.
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
    // until its name is typed, and a row being typed may carry a duplicate, so a
    // name would address two rows at once.
    getRowId: (row) => String(row.index),
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    state: { columnFilters, sorting },
  });

  const idFilter = table.getColumn('id')?.getFilterValue();
  const pageCount = Math.max(1, table.getPageCount());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter providers by name"
          placeholder="Filter names…"
          className="max-w-sm"
          value={typeof idFilter === 'string' ? idFilter : ''}
          onChange={(event) =>
            table.getColumn('id')?.setFilterValue(event.target.value)
          }
        />
        {/*
          The control row carries the one action the table offers: the plus
          opens the screen that adds a provider, which is where a new row comes
          from, so the table itself needs no button below it.
        */}
        <Button
          variant="outline"
          size="icon-sm"
          className="ml-auto shrink-0"
          aria-label="Add provider"
          disabled={addDisabled}
          onClick={onAdd}
        >
          <PlusIcon />
        </Button>
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
                      ? 'No providers yet. Add one with the + button.'
                      : 'No provider matches that name.'}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => onEdit(row.original.index)}
                >
                  {row.getAllCells().map((cell) => (
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
 * The providers the host may call, as a data table: each row names one, the kind
 * it is, the address that kind calls, and how many models it offers, and the
 * actions open the screen that configures the row or remove it. Nothing is
 * editable in place, so the table cannot carry a half-typed draft, and a row that
 * would be refused at the screen stays as the host last stored it.
 *
 * The table's control — sorting, filtering and paging, and the one plus that
 * opens the screen for a new provider — is view state that never leaves this
 * component. Opening a row does not edit the configuration here: the caller
 * names the provider it wants configured, and the position in the list is the
 * identity it addresses, so the order the table draws rows in never decides
 * which provider is configured.
 */
export function SettingsProviders({
  credentials,
  draft,
  kinds,
  onChange,
  onAdd,
  onEdit,
}: SettingsProvidersProps) {
  const providers = useMemo(() => providerRows(draft, kinds), [draft, kinds]);

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
        addDisabled={kinds.length === 0}
        loading={false}
        providers={providers}
        onAdd={onAdd}
        onEdit={onEdit}
        onRemove={(index) => onChange(removeProvider(draft, index))}
      />
    </FieldGroup>
  );
}
