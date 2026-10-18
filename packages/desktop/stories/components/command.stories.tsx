import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from 'desktop/ui/command';
import {
  FileIcon,
  FolderIcon,
  GitBranchIcon,
  MessageSquareIcon,
  PlusIcon,
  SettingsIcon,
} from 'lucide-react';

import { projects, threads } from '../support/doric.js';

export default {
  title: 'desktop/ui/Command',
  component: Command,
};

const Palette = () => (
  <>
    <CommandInput placeholder="Search Projects, Threads and commands" />
    <CommandList>
      <CommandEmpty>Nothing matches.</CommandEmpty>
      <CommandGroup heading="Actions">
        <CommandItem>
          <PlusIcon />
          New thread
          <CommandShortcut>⌘N</CommandShortcut>
        </CommandItem>
        <CommandItem>
          <GitBranchIcon />
          Switch branch
        </CommandItem>
        <CommandItem>
          <SettingsIcon />
          Open settings
          <CommandShortcut>⌘,</CommandShortcut>
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Threads">
        {threads.slice(0, 3).map((thread) => (
          <CommandItem key={thread.id}>
            <MessageSquareIcon />
            {thread.title}
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Projects">
        {projects.map((project) => (
          <CommandItem key={project.id}>
            <FolderIcon />
            {project.name}
          </CommandItem>
        ))}
      </CommandGroup>
    </CommandList>
  </>
);

export const Inline = {
  render: () => (
    <Command className="max-w-md rounded-lg border">
      <Palette />
    </Command>
  ),
};

export const Dialog = {
  render: () => (
    <CommandDialog defaultOpen>
      <Command>
        <Palette />
      </Command>
    </CommandDialog>
  ),
};

export const BranchPicker = {
  render: () => (
    <Command className="max-w-xs rounded-lg border" value="feat/app">
      <CommandInput placeholder="Find a branch" />
      <CommandList>
        <CommandEmpty>No branch matches.</CommandEmpty>
        <CommandGroup heading="Local">
          {['feat/app', 'feat/papercraft', 'main', 'fix/chat-jitter'].map(
            (branch) => (
              <CommandItem
                key={branch}
                value={branch}
                data-checked={branch === 'feat/app'}
              >
                <GitBranchIcon />
                {branch}
              </CommandItem>
            ),
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};

export const Empty = {
  render: () => (
    <Command className="max-w-md rounded-lg border">
      <CommandInput placeholder="Find a file" value="does-not-exist.tsx" />
      <CommandList>
        <CommandEmpty>No file matches.</CommandEmpty>
        <CommandGroup heading="Files">
          <CommandItem>
            <FileIcon />
            chrome-bar.tsx
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};
