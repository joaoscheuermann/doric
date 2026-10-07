import {
  type Column,
  type ColumnFiltersState,
  type ColumnVisibilityState,
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  rowPaginationFeature,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import {
  ArrowUpDownIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  type CatalogModel,
  catalogFeatures,
  effortLabel,
  isReasoningEffort,
  type ProviderModel,
} from '@/domain/config';

/**
 * One model a table draws: what the endpoint said about it, and whether the
 * endpoint listed it at all — a model an operator named is offered without the
 * catalog describing it, so the row says so rather than reading as unknown.
 */
type CatalogRow = {
  readonly model: CatalogModel;
  readonly listed: boolean;
};

/**
 * The behaviour the table opts into. TanStack Table v9 is feature-based: a table
 * keeps only what it declares here, so the sorting, filtering and visibility it
 * uses are each named, along with the sort and filter functions the columns ask
 * for by name.
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
  columnMeta: {} as { title: string },
});

/** Which behaviour the columns and the table instance below are typed against. */
type DataTableFeatures = typeof features;

const columnHelper = createColumnHelper<DataTableFeatures, CatalogRow>();

/** How many rows a page holds, in the order the control offers them. */
const pageSizes = [10, 20, 50];

/** What a column is called, in its header and in the visibility menu alike. */
const columnTitle = <TValue,>(
  column: Column<DataTableFeatures, CatalogRow, TValue>,
): string => column.columnDef.meta?.title ?? column.id;

/** A column header that sorts, naming the column in both of its spellings. */
function SortHeader<TValue>({
  column,
}: {
  readonly column: Column<DataTableFeatures, CatalogRow, TValue>;
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
 * The models one provider's catalog lists, as a table the operator ticks: one
 * column per feature the endpoint advertises, a check for each the model
 * accepts, and the reasoning efforts it names. Nothing is editable in place — a
 * tick is the whole edit — so a row is addressed by the model's own id, which
 * survives sorting, filtering and paging.
 *
 * A model the catalog does not list is drawn too, marked, because the provider
 * may offer it anyway: the catalog describes what an endpoint serves, and it is
 * not the only thing an operator may name.
 */
export function ProviderModelsTable({
  catalog,
  loading,
  offered,
  onPick,
}: {
  readonly catalog: readonly CatalogModel[];
  readonly loading: boolean;
  readonly offered: readonly ProviderModel[];
  readonly onPick: (id: string, picked: boolean) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>({});

  const offeredIds = useMemo(
    () => new Set(offered.map(({ name }) => name)),
    [offered],
  );

  const data = useMemo<readonly CatalogRow[]>(() => {
    const listed = new Set(catalog.map(({ id }) => id));

    return [
      ...catalog.map((model) => ({ model, listed: true })),
      ...offered
        .filter(({ name }) => !listed.has(name))
        .map((entry) => ({
          listed: false,
          model: {
            id: entry.name,
            reasonings: (entry.reasonings ?? []).filter(isReasoningEffort),
            parameters: [],
          } satisfies CatalogModel,
        })),
    ];
  }, [catalog, offered]);

  const featuresInCatalog = useMemo(() => catalogFeatures(catalog), [catalog]);

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: 'picked',
          header: ({ table }) => {
            // The page, not the whole list: paging is how a reader narrows 400
            // models, and a tick here must mean exactly what is on screen.
            const page = table.getRowModel().rows;
            const all = page.every((row) =>
              offeredIds.has(row.original.model.id),
            );

            return (
              <Checkbox
                aria-label="Offer every model on this page"
                checked={page.length > 0 && all}
                onCheckedChange={(value) =>
                  page.forEach(
                    (row) => void onPick(row.original.model.id, value === true),
                  )
                }
              />
            );
          },
          cell: ({ row }) => (
            <Checkbox
              aria-label={`Offer ${row.original.model.id}`}
              checked={offeredIds.has(row.original.model.id)}
              onCheckedChange={(value) =>
                onPick(row.original.model.id, value === true)
              }
            />
          ),
          enableHiding: false,
          enableSorting: false,
          meta: { title: 'Offer' },
        }),
        columnHelper.accessor(
          (row) =>
            [row.model.id, row.model.name]
              .filter((value): value is string => value !== undefined)
              .join(' '),
          {
            id: 'model',
            header: ({ column }) => <SortHeader column={column} />,
            cell: ({ row }) => (
              <div className="flex flex-col">
                <span className="truncate font-medium">
                  {row.original.model.id}
                </span>
                <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  {row.original.listed ? (
                    (row.original.model.name ?? '')
                  ) : (
                    <>
                      <TriangleAlertIcon aria-hidden className="size-3" />
                      Not in the catalog
                    </>
                  )}
                </span>
              </div>
            ),
            sortFn: 'alphanumeric',
            meta: { title: 'Model' },
          },
        ),
        columnHelper.accessor((row) => row.model.reasonings.join(', '), {
          id: 'reasoning',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => {
            const reasonings = row.original.model.reasonings;

            return reasonings.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <span className="truncate text-muted-foreground">
                {reasonings.map(effortLabel).join(' · ')}
              </span>
            );
          },
          sortFn: 'alphanumeric',
          meta: { title: 'Reasoning' },
        }),
        ...featuresInCatalog.map((feature) =>
          columnHelper.accessor(
            (row) => row.model.parameters.includes(feature),
            {
              id: `feature:${feature}`,
              header: () => (
                <span className="text-xs" title={feature}>
                  {feature}
                </span>
              ),
              cell: ({ getValue }) =>
                getValue() ? (
                  <CheckIcon aria-label={feature} className="size-4" />
                ) : null,
              enableSorting: false,
              meta: { title: feature },
            },
          ),
        ),
      ]),
    [featuresInCatalog, offeredIds, onPick],
  );

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.model.id,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    state: { columnFilters, columnVisibility, sorting },
  });

  const search = table.getColumn('model')?.getFilterValue();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search models"
          placeholder="Search models…"
          className="max-w-sm"
          value={typeof search === 'string' ? search : ''}
          onChange={(event) =>
            table.getColumn('model')?.setFilterValue(event.target.value)
          }
        />
        <span className="text-xs text-muted-foreground">
          {offered.length} offered of {data.length}
        </span>
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
                    ? 'Reading the model catalog…'
                    : data.length === 0
                      ? 'The endpoint lists no models.'
                      : 'No model matches that search.'}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
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
          Page {table.state.pagination.pageIndex + 1} of{' '}
          {Math.max(1, table.getPageCount())}
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
