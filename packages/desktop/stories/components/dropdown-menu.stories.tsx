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
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Thread actions"
            />
          }
        >
          <MoreHorizontalIcon />
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
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          View
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Panels</DropdownMenuLabel>
            <DropdownMenuCheckboxItem closeOnClick checked>
              Files
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem closeOnClick checked>
              Changes
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem closeOnClick checked={false}>
              Terminal
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem closeOnClick disabled checked={false}>
              Resources
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup value="claude-opus-4">
              {models.map((model) => (
                <DropdownMenuRadioItem
                  closeOnClick
                  key={model.id}
                  value={model.id}
                >
                  {model.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const Submenu = {
  render: () => (
    <div className="h-72">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
          Move thread
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
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>Danger zone</DropdownMenuLabel>
            <DropdownMenuItem inset variant="destructive">
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
};

export const Closed = {
  render: () => (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        Open menu
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Rename</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
