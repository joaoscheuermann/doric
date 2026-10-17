import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from 'desktop/ui/context-menu';
import {
  CopyIcon,
  FileIcon,
  FolderOpenIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

export default {
  title: 'desktop/ui/Context menu',
  component: ContextMenu,
};

/*
 * A context menu opens where the pointer asked for it, so the story asks
 * once, on mount, with the same `contextmenu` event a right click sends, a
 * little inside the trigger.
 */
const OpenOnMount = ({ children }: { readonly children: ReactNode }) => {
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = area.current;
    if (element === null) return;
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 48,
        clientY: box.top + 36,
      }),
    );
  }, []);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        ref={area}
        className="flex h-40 w-72 items-center gap-2 rounded-lg border border-dashed px-4 text-sm text-muted-foreground"
      >
        <FileIcon className="size-4" />
        chrome-bar.tsx — right-click
      </ContextMenuTrigger>
      {children}
    </ContextMenu>
  );
};

export const FileActions = {
  render: () => (
    <div className="h-80">
      <OpenOnMount>
        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuItem>
              <FolderOpenIcon />
              Open
            </ContextMenuItem>
            <ContextMenuItem>
              <CopyIcon />
              Copy path
              <ContextMenuShortcut>⌥⌘C</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem>
              <PencilIcon />
              Rename
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>Mention in thread</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>
                Add comment threads to papercraft
              </ContextMenuItem>
              <ContextMenuItem>Write stories for desktop/ui</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive">
            <Trash2Icon />
            Delete
            <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </OpenOnMount>
    </div>
  ),
};

export const CheckboxAndRadio = {
  render: () => (
    <div className="h-96">
      <OpenOnMount>
        <ContextMenuContent className="w-56">
          <ContextMenuGroup>
            <ContextMenuLabel>Show</ContextMenuLabel>
            <ContextMenuCheckboxItem closeOnClick checked>
              Hidden files
            </ContextMenuCheckboxItem>
            <ContextMenuCheckboxItem closeOnClick checked={false}>
              Ignored files
            </ContextMenuCheckboxItem>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuGroup>
            <ContextMenuLabel inset>Sort by</ContextMenuLabel>
            <ContextMenuRadioGroup value="name">
              <ContextMenuRadioItem closeOnClick value="name">
                Name
              </ContextMenuRadioItem>
              <ContextMenuRadioItem closeOnClick value="modified">
                Modified
              </ContextMenuRadioItem>
              <ContextMenuRadioItem closeOnClick value="kind">
                Kind
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuGroup>
          <ContextMenuSeparator />
          <ContextMenuItem inset disabled>
            Reveal in Finder
          </ContextMenuItem>
        </ContextMenuContent>
      </OpenOnMount>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="flex h-32 w-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
        Right-click here
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Open</ContextMenuItem>
        <ContextMenuItem>Rename</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};
