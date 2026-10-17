// Opens a control the way a reader does, once, after the story mounts. Most
// settings menus and popovers keep their open state to themselves (no `open`
// prop), so a story that shows them open presses their trigger. Every trigger
// here (a menu, a select, a popover, a collapsible or a plain button) opens on
// a click that no pointer press came before, which is what `click()` sends.
// Each step waits a few frames for the previous one's portal to draw, then
// gives up, so nothing keeps running behind the story.

import { type ReactNode, useEffect, useRef } from 'react';

export type OpenStep = {
  /** The control to press, looked up in the story's own document or shadow root. */
  readonly selector: string;
  /** Narrows the match to the control whose text is exactly this. */
  readonly text?: string;
};

const find = (
  root: Document | ShadowRoot,
  step: OpenStep,
): Element | undefined =>
  [...root.querySelectorAll(step.selector)].find(
    (element) =>
      step.text === undefined || element.textContent?.trim() === step.text,
  );

/** How many frames one step waits for its control to appear. */
const frameBudget = 30;

export function OpenOnMount({
  children,
  steps,
}: {
  readonly children: ReactNode;
  readonly steps: readonly OpenStep[];
}) {
  const anchor = useRef<HTMLDivElement>(null);
  // Pressed once per mount: a re-render must not press a toggle shut again.
  const planned = useRef(steps);

  useEffect(() => {
    const steps = planned.current;
    let frame = 0;
    let cancelled = false;
    const root = anchor.current?.getRootNode() as
      | Document
      | ShadowRoot
      | undefined;
    if (root === undefined) return;

    const run = (index: number, waited: number): void => {
      if (cancelled || index >= steps.length) return;
      const step = steps[index];
      const element = step === undefined ? undefined : find(root, step);
      if (element !== undefined) {
        (element as HTMLElement).click();
        frame = requestAnimationFrame(() => run(index + 1, 0));
        return;
      }
      if (waited < frameBudget)
        frame = requestAnimationFrame(() => run(index, waited + 1));
    };

    frame = requestAnimationFrame(() => run(0, 0));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={anchor} className="contents">
      {children}
    </div>
  );
}
