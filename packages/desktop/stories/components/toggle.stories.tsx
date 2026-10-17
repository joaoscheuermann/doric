import { Toggle } from 'desktop/ui/toggle';
import { BoldIcon, EyeIcon, PinIcon } from 'lucide-react';

export default {
  title: 'desktop/ui/Toggle',
  component: Toggle,
};

export const Default = {
  render: () => (
    <Toggle aria-label="Show resolved comments">
      <EyeIcon />
      Resolved
    </Toggle>
  ),
};

export const Pressed = {
  render: () => (
    <Toggle defaultPressed aria-label="Pin thread">
      <PinIcon />
      Pinned
    </Toggle>
  ),
};

export const Variants = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle variant="default" aria-label="Bold">
        <BoldIcon />
      </Toggle>
      <Toggle variant="outline" aria-label="Bold">
        <BoldIcon />
      </Toggle>
      <Toggle variant="outline" defaultPressed aria-label="Bold">
        <BoldIcon />
      </Toggle>
    </div>
  ),
};

export const Sizes = {
  render: () => (
    <div className="flex items-center gap-2">
      <Toggle size="sm" variant="outline">
        Small
      </Toggle>
      <Toggle size="default" variant="outline">
        Default
      </Toggle>
      <Toggle size="lg" variant="outline">
        Large
      </Toggle>
    </div>
  ),
};

export const Disabled = {
  render: () => (
    <Toggle disabled aria-label="Pin thread">
      <PinIcon />
      Pinned
    </Toggle>
  ),
};
