import { ScrollArea, ScrollBar } from 'desktop/ui/scroll-area';
import { Separator } from 'desktop/ui/separator';

import { threads } from '../support/doric.js';

export default {
  title: 'desktop/ui/Scroll area',
  component: ScrollArea,
};

const many = Array.from({ length: 6 }, (_, round) =>
  threads.map((thread) => ({ ...thread, id: `${thread.id}-${round}` })),
).flat();

export const Vertical = {
  render: () => (
    <ScrollArea className="h-64 w-72 rounded-lg border">
      <div className="p-3">
        <h4 className="mb-3 text-sm font-medium">Threads</h4>
        {many.map((thread) => (
          <div key={thread.id}>
            <div className="truncate py-1 text-sm">{thread.title}</div>
            <Separator className="my-1" />
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const Horizontal = {
  render: () => (
    <ScrollArea className="w-96 rounded-lg border whitespace-nowrap">
      <div className="flex w-max gap-3 p-3">
        {many.slice(0, 12).map((thread) => (
          <div
            key={thread.id}
            className="w-48 shrink-0 rounded-md bg-muted p-3 text-xs"
          >
            <div className="truncate font-medium">{thread.title}</div>
            <div className="text-muted-foreground">{thread.updated}</div>
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};
