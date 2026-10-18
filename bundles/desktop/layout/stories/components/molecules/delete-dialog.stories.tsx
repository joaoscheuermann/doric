import { DeleteDialog } from '../../../src/client/components/molecules/delete-dialog.js';
import { checkout, formThread } from '../../support/data.js';

const settle = () => Promise.resolve();
const ignore = () => undefined;

export default {
  title: 'Layout/Molecules/Delete dialog',
  component: DeleteDialog,
};

export const Thread = {
  render: () => (
    <DeleteDialog
      entity={{ kind: 'thread', value: formThread }}
      pending={false}
      onDelete={settle}
      onOpenChange={ignore}
    />
  ),
};

export const Project = {
  render: () => (
    <DeleteDialog
      entity={{ kind: 'project', value: checkout }}
      pending={false}
      onDelete={settle}
      onOpenChange={ignore}
    />
  ),
};

export const Deleting = {
  render: () => (
    <DeleteDialog
      entity={{ kind: 'project', value: checkout }}
      pending
      onDelete={settle}
      onOpenChange={ignore}
    />
  ),
};

/** Nothing to delete: the dialog stays closed. */
export const Closed = {
  render: () => (
    <DeleteDialog pending={false} onDelete={settle} onOpenChange={ignore} />
  ),
};
