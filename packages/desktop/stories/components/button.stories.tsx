import { Button } from 'desktop/ui/button';
import { Plus, Trash2 } from 'lucide-react';

export default {
  title: 'desktop/ui/Button',
  component: Button,
};

export const Default = {
  render: () => <Button>Send</Button>,
};

export const Variants = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="default">Default</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="solid">Solid</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const Sizes = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs">Extra small</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};

export const Icons = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button>
        <Plus data-icon="inline-start" />
        New thread
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Add">
        <Plus />
      </Button>
      <Button size="icon-sm" variant="outline" aria-label="Delete">
        <Trash2 />
      </Button>
      <Button size="icon" aria-label="Add">
        <Plus />
      </Button>
    </div>
  ),
};

export const Disabled = {
  render: () => <Button disabled>Send</Button>,
};
