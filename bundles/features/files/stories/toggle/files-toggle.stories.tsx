import { useState } from 'react';

import {
  FilesToggle,
  FilesToggleView,
} from '../../src/client/toggle/files-toggle.js';
import { storyServices } from '../support/services.js';

/**
 * `layout.panel/v1` as a story holds it: an open flag the toggle flips and a
 * listener set it notifies, so a click moves the control between the main
 * header and the panel's header.
 */
const storyPanel = (initiallyOpen: boolean) => {
  let open = initiallyOpen;
  const listeners = new Set<() => void>();
  return {
    isOpen: () => open,
    active: () => 'files',
    show: () => undefined,
    toggle: () => {
      open = !open;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
};

/** The main header's right corner and the panel's header, side by side. */
function BothHeaders({ open }: { readonly open: boolean }) {
  const [services] = useState(() =>
    storyServices({ apis: { 'layout.panel/v1': storyPanel(open) } }),
  );
  return (
    <div className="flex w-full max-w-3xl overflow-hidden rounded-md border">
      <div className="flex chrome-bar min-w-0 flex-1 items-center border-r bg-background">
        <span className="flex-1 truncate px-3 text-sm">
          Split the payment form into steps
        </span>
        <FilesToggleView services={services} placement="header" />
      </div>
      <div className="flex chrome-bar w-72 items-center justify-end gap-1 bg-sidebar px-2">
        <span className="flex-1 text-xs text-muted-foreground">Files</span>
        <FilesToggleView services={services} placement="panel" />
      </div>
    </div>
  );
}

export default {
  title: 'Files/Toggle/Files toggle',
  component: FilesToggle,
};

export const ShowFiles = {
  render: () => <FilesToggle onToggle={() => undefined} />,
};

export const HideFiles = {
  render: () => <FilesToggle onToggle={() => undefined} open />,
};

/** The panel is closed: the control sits in the main header. */
export const InHeaderWhileClosed = {
  render: () => <BothHeaders open={false} />,
};

/** The panel is open: the control moves to the panel's header. */
export const InPanelWhileOpen = {
  render: () => <BothHeaders open />,
};
