import { Button } from 'desktop/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from 'desktop/ui/popover';
import { Textarea } from 'desktop/ui/textarea';
import { MessageCircleIcon } from 'lucide-react';
import { useState } from 'react';

export default {
  title: 'desktop/ui/Popover',
  component: Popover,
};

export const Open = {
  render: () => (
    <div className="flex h-72 items-start justify-center">
      <Popover defaultOpen>
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>
          <MessageCircleIcon data-icon="inline-start" />
          Comment
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
          <PopoverTrigger render={<Button variant="outline" size="sm" />}>
            {align}
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

/*
 * The popover sits under the element it is about, not under the control that
 * opens it: the element is what the popover is positioned against, and a
 * separate button opens it.
 */
const AnchoredDemo = () => {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex h-56 flex-col items-start gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          nativeButton={false}
          render={
            <div className="w-72 rounded-md border border-dashed p-3 text-sm text-muted-foreground" />
          }
        >
          The selected element in the preview
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" className="w-72">
          <PopoverHeader>
            <PopoverTitle>Anchored to the element</PopoverTitle>
            <PopoverDescription>
              The button that opens it is a different node.
            </PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Open thread
      </Button>
    </div>
  );
};

export const Anchored = {
  render: () => <AnchoredDemo />,
};

export const Closed = {
  render: () => (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>
        Comment
      </PopoverTrigger>
      <PopoverContent>Nothing yet</PopoverContent>
    </Popover>
  ),
};
