// `frame-focus.ts` — the node's focus is the frame's: the canvas, the open
// input, the header's and the footer's controls all keep it, and so does the
// preview's iframe. Confirming or cancelling the open input, and cancelling or
// closing the open thread (Esc or its close button), hand focus to the canvas
// first, so it never leaves the node; a blur to outside the canvas does not
// refocus it. Unfocused, the first press on the frame only focuses it and the
// click it makes is consumed: on the app's own elements it is captured before
// anything sees it; over the preview, the iframe swallows it itself (the
// `first` input capture) and only reports it, and the canvas treats that report
// as the press that focused it. The window is always focused, so none of this
// applies to it.
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { FrameMessage, InputCapture } from '../frame-protocol.js';

export interface FrameFocusInput {
  readonly container: RefObject<HTMLDivElement | null>;
  readonly chrome: 'node' | 'canvas';
  /** Focuses the canvas and makes it the one the commands act on. */
  readonly focusCanvas: () => void;
}

/**
 * How long after the frame left `first` its swallowed first press may still
 * be reported: the press itself focuses the node, and the node then gives
 * the frame another capture, possibly before the press's report arrives.
 */
const FIRST_PRESS_GRACE_MS = 1000;

const now = (): number =>
  typeof performance === 'undefined' ? Date.now() : performance.now();

type FramePointer = Extract<FrameMessage, { kind: 'pointer' }>;

export const useFrameFocus = ({
  container,
  chrome,
  focusCanvas,
}: FrameFocusInput): {
  readonly focused: boolean;
  /**
   * Who handles the preview's input: the canvas, always, once the node is
   * focused (every tool inspects the preview: select and comment resolve
   * the element under a click, pan drags the view, and no click, link or
   * submit reaches the preview); before that, the frame swallows only the
   * first press, which focuses the node. The window is always focused.
   */
  readonly capture: InputCapture;
  /** Whether the focus is in the frame, read before the render it causes. */
  readonly focusedRef: RefObject<boolean>;
  /**
   * Whether a pointer report of the preview's frame was the press that only
   * focused the node (its press or its click): the canvas then ignores it.
   */
  readonly consumeFramePointer: (message: FramePointer) => boolean;
  /** The preview's frame reported its focus coming or going. */
  readonly onFrameFocus: (focused: boolean) => void;
} => {
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const capture: InputCapture = chrome === 'node' && !focused ? 'first' : 'all';
  /** The frame's press that only focused the node; its click goes too. */
  const framePress = useRef(false);
  /** Whether the frame is (or just was) in `first`, before its first press. */
  const armed = useRef({ armed: false, until: 0 });

  useEffect(() => {
    if (capture === 'first') {
      armed.current = { armed: true, until: Number.POSITIVE_INFINITY };
    } else if (armed.current.armed) {
      armed.current = { armed: true, until: now() + FIRST_PRESS_GRACE_MS };
    }
  }, [capture]);

  const enter = useCallback(() => {
    focusedRef.current = true;
    setFocused(true);
  }, []);

  const leave = useCallback(() => {
    focusedRef.current = false;
    setFocused(false);
  }, []);

  useEffect(() => {
    const frame = container.current;

    if (frame === null) return;

    /** A pointer-down that only focused the node consumes its click. */
    let focusClick = false;

    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;

      if (next instanceof Node && frame.contains(next)) return;
      leave();
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

    const onFocusIn = (event: FocusEvent) => {
      // The focus came some other way than a press over the preview (the
      // canvas, a control, the keyboard): no swallowed press is coming.
      if ((event.target as Element | null)?.tagName !== 'IFRAME')
        armed.current = { armed: false, until: 0 };
      enter();
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
  }, [container, chrome, focusCanvas, enter, leave]);

  const consumeFramePointer = useCallback(
    (message: FramePointer): boolean => {
      if (chrome !== 'node') return false;

      if (message.type === 'down') {
        // The frame swallowed the first press of `first` itself: it only
        // focuses the node, whatever focus came with it.
        const first = armed.current.armed && now() <= armed.current.until;

        armed.current = { armed: false, until: 0 };
        framePress.current = first || !focusedRef.current;
        if (framePress.current) focusCanvas();

        return framePress.current;
      }

      if (message.type === 'up') return framePress.current;

      if (message.type === 'click' && framePress.current) {
        framePress.current = false;

        return true;
      }

      return false;
    },
    [chrome, focusCanvas],
  );

  const onFrameFocus = useCallback(
    (now: boolean) => {
      if (now) {
        enter();

        return;
      }

      // The focus left the preview for the canvas or its controls: the node
      // keeps it.
      const active =
        typeof document === 'undefined' ? null : document.activeElement;

      if (active !== null && container.current?.contains(active) === true)
        return;
      leave();
    },
    [container, enter, leave],
  );

  return { focused, capture, focusedRef, consumeFramePointer, onFrameFocus };
};
