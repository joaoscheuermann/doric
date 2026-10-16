import { Badge } from 'desktop/ui/badge';
import { Checkbox } from 'desktop/ui/checkbox';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from 'desktop/ui/table';

import { threads } from '../support/doric.js';

export default {
  title: 'desktop/ui/Table',
  component: Table,
};

const statusVariant = {
  idle: 'outline',
  running: 'default',
  awaiting: 'secondary',
  failed: 'destructive',
} as const;

const tokens = new Intl.NumberFormat('en-US');

export const Default = {
  render: () => (
    <Table>
      <TableCaption>Threads in doric, newest first.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Thread</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {threads.map((thread) => (
          <TableRow key={thread.id}>
            <TableCell className="font-medium">{thread.title}</TableCell>
            <TableCell>
              <Badge variant={statusVariant[thread.status]}>
                {thread.status}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {thread.model}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {tokens.format(thread.tokens)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>Total</TableCell>
          <TableCell className="text-right tabular-nums">
            {tokens.format(
              threads.reduce((sum, thread) => sum + thread.tokens, 0),
            )}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

export const Selectable = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Checkbox checked="indeterminate" aria-label="Select all" />
          </TableHead>
          <TableHead>Thread</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {threads.map((thread, index) => (
          <TableRow
            key={thread.id}
            data-state={index < 2 ? 'selected' : undefined}
          >
            <TableCell>
              <Checkbox
                defaultChecked={index < 2}
                aria-label={`Select ${thread.title}`}
              />
            </TableCell>
            <TableCell>{thread.title}</TableCell>
            <TableCell className="text-muted-foreground">
              {thread.updated}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

export const Empty = {
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Thread</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell
            colSpan={2}
            className="h-24 text-center text-muted-foreground"
          >
            No archived Threads.
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};
