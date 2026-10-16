import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from 'desktop/ui/input-group';
import {
  ArrowUpIcon,
  CopyIcon,
  PaperclipIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react';

export default {
  title: 'desktop/ui/Input group',
  component: InputGroup,
};

export const Search = {
  render: () => (
    <InputGroup className="max-w-xs">
      <InputGroupInput placeholder="Search threads" />
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupText>5 results</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  ),
};

export const WithButtons = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      <InputGroup>
        <InputGroupInput defaultValue="feat/papercraft" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear">
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <InputGroup>
        <InputGroupAddon>
          <InputGroupText>https://</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="api.anthropic.com" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="xs">
            <CopyIcon />
            Copy
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  ),
};

export const Composer = {
  render: () => (
    <InputGroup className="max-w-2xl">
      <InputGroupTextarea placeholder="Ask Doric to change something in this Project" />
      <InputGroupAddon align="block-end">
        <InputGroupButton size="icon-xs" variant="ghost" aria-label="Attach">
          <PaperclipIcon />
        </InputGroupButton>
        <InputGroupText className="ml-auto">Claude Opus 4</InputGroupText>
        <InputGroupButton
          size="icon-xs"
          variant="default"
          className="rounded-full"
          aria-label="Send"
        >
          <ArrowUpIcon />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  ),
};

export const BlockStart = {
  render: () => (
    <InputGroup className="max-w-md">
      <InputGroupAddon align="block-start">
        <InputGroupText className="font-mono text-xs">
          packages/desktop/src/chrome-bar.tsx
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupTextarea defaultValue="Make the bar 44px on Windows." />
    </InputGroup>
  ),
};

export const States = {
  render: () => (
    <div className="flex max-w-xs flex-col gap-3">
      <InputGroup data-disabled="true">
        <InputGroupInput disabled defaultValue="Disabled" />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
      <InputGroup>
        <InputGroupInput aria-invalid defaultValue="Invalid" />
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
      </InputGroup>
    </div>
  ),
};
