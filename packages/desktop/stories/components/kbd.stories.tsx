import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from 'desktop/ui/input-group';
import { Kbd, KbdGroup } from 'desktop/ui/kbd';
import { SearchIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Kbd',
  component: Kbd,
};

export const Default = {
  render: () => <Kbd>Esc</Kbd>,
};

export const Group = {
  render: () => (
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>F</Kbd>
    </KbdGroup>
  ),
};

export const InInputGroup = {
  render: () => (
    <InputGroup className="max-w-xs">
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput placeholder="Search" aria-label="Search" />
      <InputGroupAddon align="inline-end">
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>F</Kbd>
        </KbdGroup>
      </InputGroupAddon>
    </InputGroup>
  ),
};
