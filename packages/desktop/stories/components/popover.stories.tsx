import { Button } from 'desktop/ui/button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from 'desktop/ui/popover';
import { Textarea } from 'desktop/ui/textarea';
import { MessageCircleIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Popover',
  component: Popover,
};

export const Open = {
  render: () => (
    <div className="flex h-72 items-start justify-center">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <MessageCircleIcon data-icon="inline-start" />
            Comment
          </Button>
        </PopoverTrigger>
        <PopoverContent className="flex w-80 flex-col gap-3">
          <PopoverHeader>
            <PopoverTitle>1 ChromeBar:12</PopoverTitle>
            <PopoverDescription>
              Your comment goes to the Thread with the next message.
            </PopoverDescription>
          </PopoverHeader>
          <Textarea placeholder="Make the bar 44px on Windows" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost">
              Cancel
            </Button>
            <Button size="sm">Add comment</Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

export const Aligned = {
  render: () => (
    <div className="flex h-48 items-start justify-between gap-4">
      {(['start', 'center', 'end'] as const).map((align) => (
        <Popover key={align} open>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              {align}
            </Button>
          </PopoverTrigger>
          <PopoverContent align={align} className="w-48">
            <PopoverHeader>
              <PopoverTitle>Aligned {align}</PopoverTitle>
              <PopoverDescription>To the trigger's {align}.</PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  ),
};

export const Anchored = {
  render: () => (
    <div className="flex h-56 flex-col items-start gap-2">
      <Popover defaultOpen>
        <PopoverAnchor asChild>
          <div className="w-72 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            The selected element in the preview
          </div>
        </PopoverAnchor>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost">
            Open thread
          </Button>
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-72">
          <PopoverHeader>
            <PopoverTitle>Anchored to the element</PopoverTitle>
            <PopoverDescription>
              The trigger and the anchor are different nodes.
            </PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Comment</Button>
      </PopoverTrigger>
      <PopoverContent>Nothing yet</PopoverContent>
    </Popover>
  ),
};
