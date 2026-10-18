import { Toaster } from 'desktop/ui/sonner';
import type { ComponentType } from 'react';

import { EditableName } from '../../../src/client/components/molecules/editable-name.js';

const settle = () => Promise.resolve();
const refuse = () =>
  Promise.reject(new Error('The request could not be completed.'));
const ignore = () => undefined;

export default {
  title: 'Layout/Molecules/Editable name',
  component: EditableName,
  decorators: [
    (Story: ComponentType) => (
      <div className="flex h-7 w-60 items-center bg-sidebar px-3 text-xs text-sidebar-foreground">
        <Story />
        <Toaster />
      </div>
    ),
  ],
};

export const Display = {
  render: () => (
    <EditableName
      editing={false}
      label="Thread name"
      value="Build the payment form"
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};

/** Renaming: the name is open for typing and selected. */
export const Editing = {
  render: () => (
    <EditableName
      editing
      label="Thread name"
      value="Build the payment form"
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};

/** A Thread with no name shows the placeholder until it is renamed. */
export const Untitled = {
  render: () => (
    <EditableName
      editing={false}
      label="Thread name"
      placeholder="Untitled"
      value=""
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};

/** A new entity: empty and open, so Enter does nothing until it has a name. */
export const Creating = {
  render: () => (
    <EditableName
      creating
      editing
      label="New thread name"
      value=""
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};

/** A save the host refuses: press Enter to see the mark and the toast. */
export const SaveFails = {
  render: () => (
    <EditableName
      editing
      label="Thread name"
      value="Retry failed invoices"
      onCancel={ignore}
      onSubmit={refuse}
    />
  ),
};

export const LongName = {
  render: () => (
    <EditableName
      editing={false}
      label="Thread name"
      value="Compare the plans of the five closest competitors in one table"
      onCancel={ignore}
      onSubmit={settle}
    />
  ),
};
