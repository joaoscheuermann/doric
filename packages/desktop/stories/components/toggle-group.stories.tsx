import { ToggleGroup, ToggleGroupItem } from 'desktop/ui/toggle-group';
import { Columns2Icon, RowsIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Toggle group',
  component: ToggleGroup,
};

export const Default = {
  render: () => (
    <ToggleGroup type="single" defaultValue="unified" aria-label="Diff layout">
      <ToggleGroupItem value="unified">
        <RowsIcon />
        Unified
      </ToggleGroupItem>
      <ToggleGroupItem value="split">
        <Columns2Icon />
        Split
      </ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Outline = {
  render: () => (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={0}
      defaultValue="all"
      aria-label="Thread filter"
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="running">Running</ToggleGroupItem>
      <ToggleGroupItem value="awaiting">Awaiting</ToggleGroupItem>
      <ToggleGroupItem value="archived">Archived</ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Multiple = {
  render: () => (
    <ToggleGroup
      type="multiple"
      variant="outline"
      size="sm"
      defaultValue={['files', 'changes']}
      aria-label="Panels"
    >
      <ToggleGroupItem value="files">Files</ToggleGroupItem>
      <ToggleGroupItem value="changes">Changes</ToggleGroupItem>
      <ToggleGroupItem value="terminal">Terminal</ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Vertical = {
  render: () => (
    <ToggleGroup
      type="single"
      orientation="vertical"
      variant="outline"
      spacing={0}
      defaultValue="anthropic"
      aria-label="Provider"
    >
      <ToggleGroupItem value="anthropic">Anthropic</ToggleGroupItem>
      <ToggleGroupItem value="openai">OpenAI</ToggleGroupItem>
      <ToggleGroupItem value="local">Local</ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Disabled = {
  render: () => (
    <ToggleGroup type="single" disabled defaultValue="unified">
      <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
      <ToggleGroupItem value="split">Split</ToggleGroupItem>
    </ToggleGroup>
  ),
};
