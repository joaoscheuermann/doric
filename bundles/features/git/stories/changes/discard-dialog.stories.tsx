// The Discard confirmation (§4.4 A11, A12, S18) in each state the Changes view
// shows it: one file, a whole repository, while the call runs, and with the
// sentence of a Discard that did not complete.

import { DiscardDialog } from '../../src/client/changes/discard-dialog.js';

export default {
  title: 'Git/Changes/Discard dialog',
  component: DiscardDialog,
};

const file = {
  name: 'Checkout.tsx',
  repository: '',
  paths: ['src/components/Checkout.tsx'],
};

const ignore = () => undefined;

export const OneFile = {
  render: () => (
    <DiscardDialog
      target={file}
      pending={false}
      onConfirm={ignore}
      onOpenChange={ignore}
    />
  ),
};

export const WholeRepository = {
  render: () => (
    <DiscardDialog
      target={{
        name: 'packages/design-tokens',
        repository: 'packages/design-tokens',
      }}
      pending={false}
      onConfirm={ignore}
      onOpenChange={ignore}
    />
  ),
};

export const Discarding = {
  render: () => (
    <DiscardDialog
      target={file}
      pending
      onConfirm={ignore}
      onOpenChange={ignore}
    />
  ),
};

export const Refused = {
  render: () => (
    <DiscardDialog
      target={file}
      pending={false}
      message="src/components/Checkout.tsx has a merge conflict. Resolve it before discarding."
      onConfirm={ignore}
      onOpenChange={ignore}
    />
  ),
};
