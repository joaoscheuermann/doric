// Opens a control the way a reader does, once, after the story mounts. Most
// settings menus and popovers keep their open state to themselves (no `open`
// prop), so a story that shows them open presses their trigger: a Radix menu
// or select opens on `pointerdown`, a popover, a collapsible or a button on
// `click`. Each step waits a few frames for the previous one's portal to
// draw, then gives up, so nothing keeps running behind the story.

import { type ReactNode, useEffect, useRef } from 'react';

export type OpenStep = {
  /** The control to press, looked up in the story's own document or shadow root. */
  readonly selector: string;
  /** Narrows the match to the control whose text is exactly this. */
  readonly text?: string;
  readonly gesture?: 'click' | 'pointerdown';
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

const press = (element: Element, gesture: OpenStep['gesture']): void => {
  if (gesture === 'pointerdown') {
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerType: 'mouse',
      }),
    );
    return;
  }
  (element as HTMLElement).click();
};

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
      if (element !== undefined && step !== undefined) {
        press(element, step.gesture);
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
