import { Button } from 'desktop/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from 'desktop/ui/collapsible';
import { ChevronsUpDownIcon, TerminalIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Collapsible',
  component: Collapsible,
};

const ToolCall = ({ open }: { readonly open: boolean }) => (
  <Collapsible defaultOpen={open} className="flex max-w-md flex-col gap-2">
    <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <TerminalIcon className="size-4 text-muted-foreground" />
        <span className="font-medium">shell</span>
        <span className="text-muted-foreground">npx nx show projects</span>
      </div>
      <CollapsibleTrigger
        render={
          <Button variant="ghost" size="icon-xs" aria-label="Toggle output" />
        }
      >
        <ChevronsUpDownIcon />
      </CollapsibleTrigger>
    </div>
    <CollapsibleContent>
      <pre className="rounded-lg bg-muted px-3 py-2 font-mono text-xs">
        {'bundle\ndesktop\nllms\noauth\nsandbox\nstorage\ntool'}
      </pre>
    </CollapsibleContent>
  </Collapsible>
);

export const Open = {
  render: () => <ToolCall open />,
};

export const Closed = {
  render: () => <ToolCall open={false} />,
};
