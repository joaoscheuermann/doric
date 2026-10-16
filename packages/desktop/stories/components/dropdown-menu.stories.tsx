import { Button } from 'desktop/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from 'desktop/ui/dropdown-menu';
import {
  ArchiveIcon,
  CopyIcon,
  GitForkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  Trash2Icon,
} from 'lucide-react';

import { models, projects } from '../support/doric.js';

export default {
  title: 'desktop/ui/Dropdown menu',
  component: DropdownMenu,
};

export const ThreadActions = {
  render: () => (
    <div className="h-80">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Thread actions">
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuItem>
              <PencilIcon />
              Rename
              <DropdownMenuShortcut>F2</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <PinIcon />
              Pin to top
            </DropdownMenuItem>
            <DropdownMenuItem>
              <GitForkIcon />
              Fork thread
            </DropdownMenuItem>
            <DropdownMenuItem>
              <CopyIcon />
              Copy link
              <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem>
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive">
            <Trash2Icon />
            Delete
            <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const CheckboxAndRadio = {
  render: () => (
    <div className="h-96">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            View
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel>Panels</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked>Files</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked>Changes</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={false}>
            Terminal
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem disabled checked={false}>
            Resources
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup value="claude-opus-4">
            {models.map((model) => (
              <DropdownMenuRadioItem key={model.id} value={model.id}>
                {model.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const Submenu = {
  render: () => (
    <div className="h-72">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Move thread
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuItem inset>Duplicate</DropdownMenuItem>
          <DropdownMenuSub defaultOpen>
            <DropdownMenuSubTrigger inset>
              Move to Project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {projects.map((project) => (
                <DropdownMenuItem key={project.id}>
                  {project.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuLabel inset>Danger zone</DropdownMenuLabel>
          <DropdownMenuItem inset variant="destructive">
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Open menu</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
