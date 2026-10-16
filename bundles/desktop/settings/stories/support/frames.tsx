// Where a settings component is drawn in the app, as story decorators: the
// conversation footer the execution picker sits in, the content column of a
// settings section, a popover-sized cell for the small pickers, and the whole
// settings window for templates and views.

import type { ComponentType } from 'react';

/** The workspace footer strip, with room above it for the pickers' popovers. */
export const footerFrame = (Story: ComponentType) => (
  <div className="flex min-h-96 flex-col justify-end p-6">
    <footer className="flex chrome-bar items-center gap-2 border-t bg-sidebar px-3 text-xs font-normal">
      <Story />
    </footer>
  </div>
);

/** A settings section's content column: the window's padded main area. */
export const sectionFrame = (Story: ComponentType) => (
  <div className="mx-auto max-w-3xl p-4 pb-24">
    <Story />
  </div>
);

/** A small control on its own, with room for the menu it opens. */
export const controlFrame = (Story: ComponentType) => (
  <div className="min-h-80 p-6">
    <Story />
  </div>
);

/** The settings window: the whole viewport, as a real window fills it. */
export const windowFrame = (Story: ComponentType) => (
  <div className="h-svh overflow-hidden">
    <Story />
  </div>
);
