import { Button } from 'desktop/ui/button';
import { ToolbarDivider } from 'desktop/ui/panels';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  Columns2Icon,
  RefreshCwIcon,
} from 'lucide-react';

export default {
  title: 'desktop/ui/Panels/Toolbar divider',
  component: ToolbarDivider,
};

export const Default = {
  render: () => (
    <div className="flex h-9 w-fit items-center gap-1 rounded-lg border px-1">
      <Button size="icon-xs" variant="ghost" aria-label="Previous change">
        <ChevronUpIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Next change">
        <ChevronDownIcon />
      </Button>
      <ToolbarDivider />
      <Button size="icon-xs" variant="ghost" aria-label="Split view">
        <Columns2Icon />
      </Button>
      <ToolbarDivider />
      <Button size="icon-xs" variant="ghost" aria-label="Refresh">
        <RefreshCwIcon />
      </Button>
    </div>
  ),
};
