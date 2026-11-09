// Where the working directory lives: the Files column footer, at the bottom of
// the 328 px column on the sidebar canvas, with room above it for the popovers
// that open upwards.

import { type ComponentType, type ReactNode, useEffect, useRef } from 'react';

/**
 * Draws a story as a `layout.panel.footer` item: inside the Files column's
 * 40 px footer band (no border, no fill), in its one 28 px row, at the bottom
 * of a 328 px column on `bg-sidebar` that is tall enough for the upward
 * popovers.
 */
export const footerDecorators = [
  (Story: ComponentType) => (
    <div className="flex min-h-[28rem] w-[328px] flex-col justify-end bg-sidebar">
      <div className="flex h-10 shrink-0 items-center px-2">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1">
          <Story />
        </div>
      </div>
    </div>
  ),
];

/**
 * Opens the overlays a story shows by clicking their triggers once after
 * mount, in order: the triggers own their open state, so no prop opens
 * them. Triggers are looked up in the story's root (a shadow root in a
 * papercraft preview), where the overlays portal too.
 */
export function OpenOnMount({
  labels,
  children,
}: {
  readonly labels: readonly string[];
  readonly children?: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const root = anchor.current?.getRootNode() as ParentNode | undefined;
    if (root === undefined) return;
    const timers = labels.map((label, index) =>
      setTimeout(
        () => {
          root.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.click();
        },
        100 + index * 150,
      ),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [labels]);
  return (
    <>
      <span ref={anchor} hidden />
      {children}
    </>
  );
}
