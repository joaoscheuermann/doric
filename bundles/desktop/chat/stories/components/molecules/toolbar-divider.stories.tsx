import { Button } from 'desktop/ui/button';
import { ArrowUpIcon, GitBranchIcon } from 'lucide-react';

import { ToolbarDivider } from '../../../src/client/components/molecules/toolbar-divider.js';

export default {
  title: 'Chat/Molecules/Toolbar divider',
  component: ToolbarDivider,
};

/** Between the footer's controls, shorter than the bar it divides. */
export const InFooter = {
  render: () => (
    <footer className="flex chrome-bar items-center justify-end gap-2 border-t bg-sidebar px-2">
      <Button size="xs" variant="ghost">
        <GitBranchIcon data-icon="inline-start" />
        main
      </Button>
      <ToolbarDivider />
      <Button size="icon-sm" variant="solid" aria-label="Send (Cmd+Enter)">
        <ArrowUpIcon />
      </Button>
    </footer>
  ),
};
