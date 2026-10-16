import { Button } from 'desktop/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from 'desktop/ui/tooltip';
import { GitBranchIcon, PlusIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Tooltip',
  component: Tooltip,
};

export const Open = {
  render: () => (
    <div className="flex h-32 items-end justify-center">
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="outline" aria-label="New thread">
            <PlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>New thread</TooltipContent>
      </Tooltip>
    </div>
  ),
};

export const Sides = {
  render: () => (
    <div className="grid h-64 grid-cols-2 place-items-center gap-16 px-24">
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <Tooltip key={side} open>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              {side}
            </Button>
          </TooltipTrigger>
          <TooltipContent side={side}>Shown on the {side}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  ),
};

export const LongContent = {
  render: () => (
    <div className="flex h-36 items-end justify-center">
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm">
            <GitBranchIcon data-icon="inline-start" />
            feat/app
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          ~/Documents/personal/doric/doric · 3 files changed, 2 ahead of
          origin/main
        </TooltipContent>
      </Tooltip>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline">Hover me</Button>
      </TooltipTrigger>
      <TooltipContent>Archive thread</TooltipContent>
    </Tooltip>
  ),
};
