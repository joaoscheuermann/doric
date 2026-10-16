import { Button } from 'desktop/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from 'desktop/ui/popover';
import { PortalContainerProvider } from 'desktop/ui/portal-container';
import { useState } from 'react';

export default {
  title: 'desktop/ui/Portal container',
  component: PortalContainerProvider,
};

/*
 * `PortalContainerProvider` draws nothing: it tells every `desktop/ui`
 * overlay below it where to portal. The story names a visible box as that
 * container, so the open overlays appear inside it rather than at the end of
 * the document.
 */
const Demo = () => {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <PortalContainerProvider container={container}>
        <div className="flex gap-2">
          <Popover defaultOpen>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                Popover
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64">
              <PopoverHeader>
                <PopoverTitle>Portaled into the box</PopoverTitle>
                <PopoverDescription>
                  Its DOM lives in the container below.
                </PopoverDescription>
              </PopoverHeader>
            </PopoverContent>
          </Popover>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Menu
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Rename</DropdownMenuItem>
              <DropdownMenuItem>Archive</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PortalContainerProvider>
      <div
        ref={setContainer}
        data-testid="portal-target"
        className="relative h-56 rounded-lg border border-dashed p-2 text-xs text-muted-foreground"
      >
        Portal container
      </div>
    </div>
  );
};

export const Default = {
  render: () => <Demo />,
};
