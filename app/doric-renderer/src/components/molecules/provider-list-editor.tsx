import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
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
import { PlusIcon, TrashIcon } from 'lucide-react';

type ProviderListEditorProps = {
  readonly label: string;
  /** What the control that appends an entry is called. */
  readonly addLabel: string;
  readonly entries: readonly string[];
  /**
   * The values an entry may be, when the list is a closed set. Absent means the
   * entries are free text the reader types.
   */
  readonly choices?: readonly string[];
  /** How a chosen value is shown, when the value is not its own label. */
  readonly choiceLabel?: (value: string) => string;
  readonly placeholder?: string;
  readonly description?: string;
  readonly onChange: (entries: readonly string[]) => void;
};

/**
 * One of a provider's per-provider lists, edited as a table: a header naming the
 * list, a row per entry, the entry drawn inline, a remove action on the row, and
 * one control that appends a new entry. The same unit serves every list the
 * catalog declares, because a kind says which lists it keeps and this says
 * nothing about which list it is: a list of free text entries is typed, and a
 * closed one is chosen.
 */
export function ProviderListEditor({
  addLabel,
  choiceLabel,
  choices,
  description,
  entries,
  label,
  onChange,
  placeholder,
}: ProviderListEditorProps) {
  const replace = (index: number, value: string): void =>
    onChange(entries.map((entry, at) => (at === index ? value : entry)));
  const remove = (index: number): void =>
    onChange(entries.filter((_, at) => at !== index));
  const append = (): void => onChange([...entries, choices?.[0] ?? '']);

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{label}</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry, index) => (
            <TableRow key={index}>
              <TableCell className="p-2">
                {choices === undefined ? (
                  <Input
                    aria-label={`${label} ${index + 1}`}
                    autoComplete="off"
                    placeholder={placeholder}
                    value={entry}
                    onChange={(event) => replace(index, event.target.value)}
                  />
                ) : (
                  <Select
                    value={entry}
                    onValueChange={(value) => replace(index, value)}
                  >
                    <SelectTrigger
                      aria-label={`${label} ${index + 1}`}
                      className="w-full"
                    >
                      <SelectValue
                        placeholder={placeholder ?? 'Choose a value'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {choices.map((choice) => (
                          <SelectItem key={choice} value={choice}>
                            {choiceLabel === undefined
                              ? choice
                              : choiceLabel(choice)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              </TableCell>
              <TableCell className="w-10 p-2 text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${label} ${index + 1}`}
                  onClick={() => remove(index)}
                >
                  <TrashIcon />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {entries.length === 0 && <FieldDescription>None yet.</FieldDescription>}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={append}
      >
        <PlusIcon data-icon="inline-start" />
        {addLabel}
      </Button>
      {description !== undefined && (
        <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  );
}
