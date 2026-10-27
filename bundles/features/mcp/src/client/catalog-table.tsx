// What a connected MCP server offers — its tools or its skills — as a table
// the reader filters by name or description.

import { FieldSet, FieldTitle } from 'desktop/ui/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from 'desktop/ui/input-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'desktop/ui/table';
import { SearchIcon } from 'lucide-react';
import { useId, useState } from 'react';

import type { McpSkillView, McpToolView } from '../contracts/index.js';

interface CatalogWords {
  readonly legend: string;
  readonly filter: string;
  readonly placeholder: string;
  readonly empty: string;
  readonly unmatched: string;
}

export const toolWords: CatalogWords = {
  legend: 'Tools',
  filter: 'Filter tools',
  placeholder: 'Filter tools…',
  empty: 'No tools',
  unmatched: 'No tool matches that filter.',
};

export const skillWords: CatalogWords = {
  legend: 'Skills',
  filter: 'Filter skills',
  placeholder: 'Filter skills…',
  empty: 'No skills',
  unmatched: 'No skill matches that filter.',
};

/** Lists `items` by name and description, filtered by what the reader types. */
export function CatalogTable({
  words,
  items,
}: {
  readonly words: CatalogWords;
  readonly items: readonly (McpToolView | McpSkillView)[];
}) {
  const titleId = useId();
  const [filter, setFilter] = useState('');

  const needle = filter.trim().toLowerCase();
  const shown = items.filter(
    (item) =>
      item.name.toLowerCase().includes(needle) ||
      item.description?.toLowerCase().includes(needle),
  );

  const empty =
    items.length === 0
      ? words.empty
      : shown.length === 0
        ? words.unmatched
        : undefined;

  return (
    // A legend cannot share a flex row with the filter, so the title names the
    // fieldset through aria-labelledby instead.
    <FieldSet className="gap-2" aria-labelledby={titleId}>
      <div className="flex items-center justify-between gap-2">
        <FieldTitle id={titleId}>{words.legend}</FieldTitle>
        <InputGroup className="w-56">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={words.filter}
            placeholder={words.placeholder}
            autoComplete="off"
            spellCheck={false}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </InputGroup>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-2/5">Name</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {empty !== undefined ? (
              <TableRow>
                <TableCell
                  colSpan={2}
                  className="h-16 text-center text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              shown.map((item) => (
                <TableRow key={'uri' in item ? item.uri : item.name}>
                  <TableCell>
                    <span className="font-mono">{item.name}</span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <span className="line-clamp-2 text-muted-foreground">
                      {item.description}
                    </span>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </FieldSet>
  );
}
