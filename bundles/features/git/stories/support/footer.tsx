// Where the working directory lives: the conversation footer under the
// composer, with room above it for the popovers that open upwards.

import { type ComponentType, type ReactNode, useEffect, useRef } from 'react';

export const footerDecorators = [
  (Story: ComponentType) => (
    <div className="flex min-h-[28rem] max-w-3xl flex-col justify-end">
      <div className="flex h-9 min-w-0 items-center gap-1 rounded-md border px-2">
        <Story />
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
