import { Button } from 'desktop/ui/button';
import { ChromeBar } from 'desktop/ui/chrome-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import {
  GitBranchIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';

export default {
  title: 'desktop/ui/Chrome bar',
  component: ChromeBar,
};

/** The macOS window buttons' safe area, as the main process states it. */
const macOS = { '--doric-safe-left': '78px' } as CSSProperties;

export const Default = {
  render: () => (
    <div className="overflow-hidden rounded-lg border" style={macOS}>
      <ChromeBar className="gap-1 border-b bg-sidebar px-2">
        <div className="flex items-center gap-1 [app-region:no-drag]">
          <Button size="icon-sm" variant="ghost" aria-label="Toggle sidebar">
            <PanelLeftIcon />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label="New thread">
                <PlusIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New thread</TooltipContent>
          </Tooltip>
        </div>
        <span className="min-w-0 flex-1 truncate text-center text-sm font-medium">
          Add comment threads to papercraft previews
        </span>
        <div className="flex items-center gap-1 [app-region:no-drag]">
          <Button size="xs" variant="ghost">
            <GitBranchIcon data-icon="inline-start" />
            feat/app
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Toggle panel">
            <PanelRightIcon />
          </Button>
        </div>
      </ChromeBar>
      <div className="h-32 p-4 text-sm text-muted-foreground">
        The window's content starts below the bar.
      </div>
    </div>
  ),
};

export const WithoutInset = {
  render: () => (
    <div className="overflow-hidden rounded-lg border" style={macOS}>
      <ChromeBar inset={false} className="border-b px-3">
        <span className="text-sm font-medium">Settings</span>
      </ChromeBar>
    </div>
  ),
};

export const Empty = {
  render: () => (
    <div className="overflow-hidden rounded-lg border" style={macOS}>
      <ChromeBar className="border-b bg-sidebar" />
    </div>
  ),
};
