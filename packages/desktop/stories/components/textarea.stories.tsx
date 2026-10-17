import { Textarea } from 'desktop/ui/textarea';

export default {
  title: 'desktop/ui/Textarea',
  component: Textarea,
};

export const Default = {
  render: () => (
    <Textarea
      className="max-w-lg"
      placeholder="Ask Doric to change something in this Project"
    />
  ),
};

export const Filled = {
  render: () => (
    <Textarea
      className="max-w-lg"
      defaultValue={
        'Write stories for every component in packages/desktop.\n\nKeep the harness and render overlays open.'
      }
    />
  ),
};

export const Disabled = {
  render: () => (
    <Textarea
      className="max-w-lg"
      disabled
      defaultValue="Waiting for the current turn to finish…"
    />
  ),
};

export const Invalid = {
  render: () => (
    <Textarea
      className="max-w-lg"
      aria-invalid
      defaultValue="This system prompt is longer than the provider allows."
    />
  ),
};
