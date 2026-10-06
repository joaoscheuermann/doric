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
import { toast } from 'sonner';

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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  type Credential,
  type CredentialDraft,
  type CredentialKind,
  credentialCreate,
  credentialDraftOf,
  credentialFields,
  credentialIssue,
  credentialKindDescription,
  credentialKindLabel,
  credentialKinds,
  credentialUpdate,
  emptyCredentialDraft,
} from '@/domain/config';
import { useCredentials } from '@/hooks/use-credentials';

/**
 * The fields one kind asks for. The set comes from `credentialFields`, so the
 * form and the host's rule cannot disagree about what a kind carries, and a
 * field the kind forbids is not rendered at all.
 */
function CredentialFields({
  draft,
  onChange,
  editing,
}: {
  readonly draft: CredentialDraft;
  readonly onChange: (next: CredentialDraft) => void;
  readonly editing: boolean;
}) {
  const fields = credentialFields(draft.kind);

  return (
    <>
      <Field>
        <FieldLabel htmlFor="credential-name">Name</FieldLabel>
        <Input
          id="credential-name"
          autoComplete="off"
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
        <FieldDescription>
          How this credential is named wherever one is chosen.
        </FieldDescription>
      </Field>
      {fields.includes('username') && (
        <Field>
          <FieldLabel htmlFor="credential-username">Username</FieldLabel>
          <Input
            id="credential-username"
            autoComplete="off"
            value={draft.username ?? ''}
            onChange={(event) =>
              onChange({ ...draft, username: event.target.value })
            }
          />
        </Field>
      )}
      {fields.includes('email') && (
        <Field>
          <FieldLabel htmlFor="credential-email">Email</FieldLabel>
          <Input
            id="credential-email"
            type="email"
            autoComplete="off"
            value={draft.email ?? ''}
            onChange={(event) =>
              onChange({ ...draft, email: event.target.value })
            }
          />
        </Field>
      )}
      {fields.includes('secret') && (
        <Field>
          <FieldLabel htmlFor="credential-secret">
            {draft.kind === 'API_TOKEN' ? 'Token' : 'Password'}
          </FieldLabel>
          <Input
            id="credential-secret"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={draft.secret ?? ''}
            onChange={(event) =>
              onChange({ ...draft, secret: event.target.value })
            }
          />
          <FieldDescription>
            {editing
              ? 'Leave this empty to keep the stored secret. Whatever you type is sent only to the host, which stores it and never sends it back.'
              : 'Sent only to the host, which stores it and never sends it back.'}
          </FieldDescription>
        </Field>
      )}
    </>
  );
}

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
  // Type-only: it names the title each column carries, so the header a person
  // reads and the entry in the visibility menu are one word, not two spellings
  // of it. The value is a phantom; the library strips it at construction.
  columnMeta: {} as { title: string },
});

/** Which behaviour the columns and the table instance below are typed against. */
type DataTableFeatures = typeof features;

/** One credential as a table draws it: the stored row, and nothing derived. */
type CredentialRow = { readonly credential: Credential };

const columnHelper = createColumnHelper<DataTableFeatures, CredentialRow>();

/** How many rows a page holds, in the order the control offers them. */
const pageSizes = [10, 20, 50];

/** What a column is called, in its header and in the visibility menu alike. */
const columnTitle = <TValue,>(
  column: Column<DataTableFeatures, CredentialRow, TValue>,
): string => column.columnDef.meta?.title ?? column.id;

/**
 * A column header that sorts, naming the column in both of its spellings. It is
 * generic over the column's value because a column may be keyed by a union — a
 * credential kind, for one — and the header only ever reads the column's title.
 */
function SortHeader<TValue>({
  column,
}: {
  readonly column: Column<DataTableFeatures, CredentialRow, TValue>;
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
 * The stored credentials as a table: each row names one, says its kind, what it
 * carries, and whether a secret is stored. The secret itself is never a column,
 * because the host never sends it, and the actions open the dialog that edits the
 * row or remove it.
 *
 * Nothing here is editable in place, so the row's identity is the credential's
 * own id rather than a position: sorting and filtering draw the rows in any order
 * and an action still names the credential it was drawn for.
 */
function CredentialTable({
  credentials,
  loading,
  onEdit,
  onRemove,
}: {
  readonly credentials: readonly Credential[];
  readonly loading: boolean;
  readonly onEdit: (credential: Credential) => void;
  readonly onRemove: (credential: Credential) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] =
    useState<ColumnVisibilityState>({});

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((row) => row.credential.name, {
          id: 'name',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="truncate font-medium">
              {row.original.credential.name}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Name' },
        }),
        columnHelper.accessor((row) => row.credential.kind, {
          id: 'kind',
          header: ({ column }) => <SortHeader column={column} />,
          cell: ({ row }) => (
            <span className="text-muted-foreground">
              {credentialKindLabel(row.original.credential.kind)}
            </span>
          ),
          sortFn: 'alphanumeric',
          meta: { title: 'Kind' },
        }),
        columnHelper.accessor(
          (row) => row.credential.username ?? row.credential.email ?? '',
          {
            id: 'identity',
            header: ({ column }) => <SortHeader column={column} />,
            cell: ({ row }) => {
              const { credential } = row.original;
              const shown = [credential.username, credential.email]
                .filter((value): value is string => value !== undefined)
                .join(' \u00b7 ');
              return shown === '' ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="truncate text-muted-foreground">{shown}</span>
              );
            },
            sortFn: 'alphanumeric',
            meta: { title: 'Identity' },
          },
        ),
        columnHelper.accessor(
          (row) =>
            row.credential.hasSecret ? 'Secret stored' : 'No secret yet',
          {
            id: 'secret',
            header: ({ column }) => <SortHeader column={column} />,
            cell: ({ row }) => (
              <span className="text-muted-foreground">
                {row.original.credential.hasSecret
                  ? 'Secret stored'
                  : 'No secret yet'}
              </span>
            ),
            sortFn: 'alphanumeric',
            meta: { title: 'Secret' },
          },
        ),
        columnHelper.display({
          id: 'actions',
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => (
            // The row opens the credential it draws, so the menu has to keep its
            // own clicks to itself: without this, opening Delete would also open
            // the dialog behind it.
            <div
              className="flex justify-end"
              onClick={(event) => event.stopPropagation()}
            >
              <RowActions
                label={row.original.credential.name}
                actions={[
                  {
                    label: 'Edit',
                    icon: <PencilIcon />,
                    onSelect: () => onEdit(row.original.credential),
                  },
                  {
                    label: 'Delete',
                    destructive: true,
                    icon: <TrashIcon />,
                    onSelect: () => onRemove(row.original.credential),
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

  // The data is the rows themselves, because nothing here edits one in place:
  // the table only draws them, and an action carries the credential it names.
  const data = useMemo(
    () => credentials.map((credential) => ({ credential })),
    [credentials],
  );

  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.credential.id,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    state: { columnFilters, columnVisibility, sorting },
  });

  const nameFilter = table.getColumn('name')?.getFilterValue();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Filter credentials by name"
          placeholder="Filter names…"
          className="max-w-sm"
          value={typeof nameFilter === 'string' ? nameFilter : ''}
          onChange={(event) =>
            table.getColumn('name')?.setFilterValue(event.target.value)
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
                    ? 'Reading the stored credentials…'
                    : data.length === 0
                      ? 'No credentials are stored yet.'
                      : 'No credential matches that name.'}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() => onEdit(row.original.credential)}
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

/**
 * The form that adds or edits one credential, in a dialog. The kind decides
 * which fields are rendered, and a kind is fixed once the credential exists —
 * changing it would change which fields the stored row may carry.
 *
 * The secret is the one field this form never fills in from the store: the host
 * answers whether one is stored and never the value, so an edit opens with the
 * field empty and an empty field keeps what is stored.
 */
function CredentialDialog({
  draft,
  onChange,
  onClose,
  onSave,
}: {
  readonly draft: CredentialDraft;
  readonly onChange: (next: CredentialDraft) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
}) {
  const editing = draft.id !== undefined;
  const issue = credentialIssue(draft);

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
            {editing ? 'Edit credential' : 'Add credential'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Change what the host stores for this credential. Its kind cannot be changed once it exists.'
              : 'A named secret the host stores and never sends back, which a provider or the Git integrations can then choose.'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="credential-kind">Kind</FieldLabel>
            <Select
              value={draft.kind}
              onValueChange={(value) =>
                onChange({
                  ...emptyCredentialDraft(value as CredentialKind),
                  id: draft.id,
                  name: draft.name,
                })
              }
              disabled={editing}
            >
              <SelectTrigger id="credential-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {credentialKinds.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {credentialKindLabel(kind)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {editing
                ? 'A kind cannot be changed once the credential exists.'
                : credentialKindDescription(draft.kind)}
            </FieldDescription>
          </Field>

          <CredentialFields
            draft={draft}
            editing={editing}
            onChange={onChange}
          />

          {issue !== undefined && (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertTitle>This credential cannot be saved yet</AlertTitle>
              <AlertDescription>{issue}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={issue !== undefined} onClick={onSave}>
            {editing ? 'Save credential' : 'Add credential'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The host's credential store as a data table. A credential is named, has one of
 * a closed set of kinds, and the kind is what decides which fields it carries:
 * `API_TOKEN` is authentication and holds one secret, `USERNAME_PASSWORD` is
 * authentication with a name, and `GIT` is identity alone and holds no secret at
 * all.
 *
 * The secret is the one value this surface never reads, so the table shows
 * whether one is stored rather than the value, and the dialog that edits a row
 * opens with the field empty.
 *
 * A write is announced where it was made: the dialog says the credential was
 * saved or added before it closes, and the row's deletion is confirmed after it
 * is gone. A failure is announced too, and leaves the dialog open on what the
 * user typed, because the reason names the entry that has to be corrected and the
 * entry is in the dialog. Every message carries one id per kind of write, so
 * repeating the same outcome replaces its own toast instead of stacking.
 */
export function SettingsCredentials() {
  const credentials = useCredentials();
  const [draft, setDraft] = useState<CredentialDraft>();

  const save = async (): Promise<void> => {
    if (draft === undefined || credentialIssue(draft) !== undefined) return;
    const stored = credentials.list.find(
      (credential) => credential.id === draft.id,
    );
    const result =
      stored === undefined
        ? await credentials.create(credentialCreate(draft))
        : await credentials.update(stored.id, credentialUpdate(draft, stored));
    if (result.status === 'failed') {
      toast.error(result.message, { id: 'credentials-write' });
      return;
    }
    setDraft(undefined);
    toast.success(
      stored === undefined ? 'Credential added.' : 'Credential saved.',
      { id: 'credentials-write' },
    );
  };

  const remove = async (credential: Credential): Promise<void> => {
    const result = await credentials.remove(credential.id);
    if (result.status === 'failed') {
      toast.error(result.message, { id: 'credentials-write' });
      return;
    }
    toast.success(`Removed ${credential.name}.`, { id: 'credentials-write' });
  };

  return (
    <div className="flex flex-col gap-4">
      <CredentialTable
        credentials={credentials.list}
        loading={credentials.loading}
        onEdit={(credential) => setDraft(credentialDraftOf(credential))}
        onRemove={(credential) => void remove(credential)}
      />

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setDraft(emptyCredentialDraft('API_TOKEN'))}
      >
        <PlusIcon data-icon="inline-start" />
        Add credential
      </Button>

      {draft !== undefined && (
        <CredentialDialog
          draft={draft}
          onChange={setDraft}
          onClose={() => setDraft(undefined)}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}
