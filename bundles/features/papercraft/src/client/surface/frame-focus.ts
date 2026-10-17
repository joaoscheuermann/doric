// `frame-focus.ts` — the node's focus is the frame's: the canvas, the open
// input, the header's and the footer's controls all keep it. Unfocused, the
// first press on the frame only focuses it — captured before anything inside
// sees it, the artifact's own handlers included — and the click it makes is
// consumed. The window is always focused, so none of this applies to it.

import { type RefObject, useEffect, useRef, useState } from 'react';

export interface FrameFocusInput {
  readonly container: RefObject<HTMLDivElement | null>;
  readonly chrome: 'node' | 'canvas';
  /** Focuses the canvas and makes it the one the commands act on. */
  readonly focusCanvas: () => void;
}

export const useFrameFocus = ({
  container,
  chrome,
  focusCanvas,
}: FrameFocusInput): {
  readonly focused: boolean;
  /** Whether the focus is in the frame, read before the render it causes. */
  readonly focusedRef: RefObject<boolean>;
} => {
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);

  useEffect(() => {
    const frame = container.current;

    if (frame === null) return;

    /** A pointer-down that only focused the node consumes its click. */
    let focusClick = false;

    const onFocusIn = () => {
      focusedRef.current = true;
      setFocused(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;

      if (next instanceof Node && frame.contains(next)) return;
      focusedRef.current = false;
      setFocused(false);
    };
    const focusFrame = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      focusCanvas();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (chrome !== 'node' || focusedRef.current) return;
      focusClick = true;
      focusFrame(event);
    };
    const onClick = (event: MouseEvent) => {
      if (chrome !== 'node') return;
      if (!focusClick && focusedRef.current) return;
      focusClick = false;
      focusFrame(event);
    };

    frame.addEventListener('focusin', onFocusIn);
    frame.addEventListener('focusout', onFocusOut);
    frame.addEventListener('pointerdown', onPointerDown, { capture: true });
    frame.addEventListener('click', onClick, { capture: true });

    return () => {
      frame.removeEventListener('focusin', onFocusIn);
      frame.removeEventListener('focusout', onFocusOut);
      frame.removeEventListener('pointerdown', onPointerDown, {
        capture: true,
      });
      frame.removeEventListener('click', onClick, { capture: true });
    };
  }, [container, chrome, focusCanvas]);

  return { focused, focusedRef };
};
