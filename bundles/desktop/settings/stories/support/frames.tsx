// Where a settings component is drawn in the app, as story decorators: the
// conversation footer the execution picker sits in, the content column of a
// settings section, a popover-sized cell for the small pickers, and the whole
// settings window for templates and views.
//
// Each draws the inset-card look of the app (ui-redesign; Figma `36:22049`,
// `32:51299`): the `--sidebar` canvas, and on it the content card — the
// `--background` fill, a 10px radius and the small shadow, no border.

import type { ComponentType } from 'react';

/**
 * The conversation footer band at the end of the conversation's card, with
 * room above it for the pickers' popovers: 28px tall, no rule and no fill of
 * its own (`workspace-view.tsx`).
 */
export const footerFrame = (Story: ComponentType) => (
  <div className="bg-sidebar p-2">
    <div className="flex min-h-96 flex-col justify-end overflow-hidden rounded-xl bg-background p-2 shadow-sm">
      <footer className="flex h-7 shrink-0 items-center justify-end gap-1 pl-2 text-[11px] font-normal text-muted-foreground">
        <Story />
      </footer>
    </div>
  </div>
);

/** A settings section's content column: the window's card and its padding. */
export const sectionFrame = (Story: ComponentType) => (
  <div className="bg-sidebar p-2">
    <div className="rounded-xl bg-background shadow-sm">
      <div className="mx-auto max-w-3xl p-4 pb-24">
        <Story />
      </div>
    </div>
  </div>
);

/** A small control on its own, with room for the menu it opens. */
export const controlFrame = (Story: ComponentType) => (
  <div className="min-h-80 p-6">
    <Story />
  </div>
);

/**
 * The settings window: the whole viewport, as a real window fills it, on the
 * `--sidebar` canvas the window's frame paints.
 */
export const windowFrame = (Story: ComponentType) => (
  <div className="h-svh overflow-hidden bg-sidebar">
    <Story />
  </div>
);
