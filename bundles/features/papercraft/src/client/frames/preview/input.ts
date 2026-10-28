// The preview frame's input capture (frame-protocol.ts, `InputCapture`).
//
// The frame's listeners are the window's first, in the capture phase, bound
// before the revision's module loads, so a swallowed event reaches none of
// the preview's handlers (React's root listeners included) and its default
// action (a link, a submit, a focus) never runs.
//
// - `all`: every pointer, mouse, touch and key event is swallowed; pointer
//   moves, presses, releases, clicks and the pointer leaving the frame are
//   reported with the scene node under them, the wheel is reported and its
//   scroll prevented, and the canvas's keys (space, `c`, Escape) reported.
// - `first`: the same until the first `pointerdown`, which is reported and
//   swallowed with the rest of its gesture (its release and click); from
//   then on, as `none`.
// - `none`: the preview handles its input; the frame still reports the
//   pointer and the wheel, and the canvas's keys typed outside an editable
//   field (Escape anywhere).
//
// The frame's focus is reported as it comes and goes.

import type {
  FrameMessage,
  InputCapture,
  PseudoKind,
} from '../../frame-protocol.js';
import { type FrameScene, nodeOfPath, pseudoAtPoint } from './scene.js';

type Report = (message: FrameMessage) => void;

/** Everything a swallowing frame keeps from the preview. */
const SWALLOWED = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'pointercancel',
  'gotpointercapture',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'keydown',
  'keyup',
  'keypress',
  'beforeinput',
  'submit',
  'dragstart',
  'selectstart',
] as const;

/** The rest of a gesture whose `pointerdown` only focused the preview. */
const GESTURE = new Set([
  'pointerup',
  'mousedown',
  'mouseup',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
]);

const POINTER_TYPES: Readonly<
  Record<string, 'move' | 'down' | 'up' | 'click'>
> = {
  pointermove: 'move',
  pointerdown: 'down',
  pointerup: 'up',
  click: 'click',
};

const isCanvasKey = (key: string): boolean =>
  key === ' ' || key === 'c' || key === 'C' || key === 'Escape';

const isEditable = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;

  if (element === null || typeof element.tagName !== 'string') return false;

  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable === true
  );
};

const modifiersOf = (event: MouseEvent | KeyboardEvent) => ({
  altKey: event.altKey === true,
  ctrlKey: event.ctrlKey === true,
  metaKey: event.metaKey === true,
  shiftKey: event.shiftKey === true,
});

const pathOf = (event: Event): EventTarget[] => {
  const path =
    typeof event.composedPath === 'function' ? event.composedPath() : [];

  if (path.length > 0) return path;

  const parents: EventTarget[] = [];

  for (
    let node = event.target as Node | null;
    node !== null && node !== undefined;
    node = node.parentNode
  ) {
    parents.push(node);
  }

  return parents;
};

const intOf = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) ? value : 0;

const numberOf = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export interface FrameInput {
  readonly setCapture: (capture: InputCapture) => void;
  readonly stop: () => void;
}

export const watchInput = (input: {
  readonly win: Window;
  readonly report: Report;
  readonly scene: () => FrameScene | undefined;
}): FrameInput => {
  const { win, report } = input;
  let capture: InputCapture = 'none';
  /** `first`, before its first `pointerdown`. */
  let armed = false;
  /** The gesture of the `pointerdown` that only focused the preview. */
  let focusGesture = false;

  const pointOf = (event: MouseEvent) => ({
    x: numberOf(event.clientX) + numberOf(win.scrollX),
    y: numberOf(event.clientY) + numberOf(win.scrollY),
  });

  const reportPointer = (
    type: 'move' | 'down' | 'up' | 'click' | 'leave',
    event: MouseEvent,
  ): void => {
    const point = pointOf(event);
    let target: { nodeId?: string; pseudo?: PseudoKind } = {};

    if (type !== 'leave') {
      const scene = input.scene();
      const node =
        scene === undefined ? undefined : nodeOfPath(scene, pathOf(event));

      if (node !== undefined) {
        const pseudo = pseudoAtPoint(node, point);

        target = {
          nodeId: node.data.id,
          ...(pseudo === undefined ? {} : { pseudo }),
        };
      }
    }

    report({
      kind: 'pointer',
      type,
      point,
      button: intOf(event.button),
      buttons: intOf(event.buttons),
      ...target,
      ...modifiersOf(event),
    });
  };

  const reportKey = (event: KeyboardEvent): void => {
    report({
      kind: 'key',
      type: event.type === 'keyup' ? 'keyup' : 'keydown',
      key: String(event.key).slice(0, 32),
      code: String(event.code ?? '').slice(0, 32),
      repeat: event.repeat === true,
      ...modifiersOf(event),
    });
  };

  const swallow = (event: Event): void => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onEvent = (event: Event): void => {
    const type = event.type;
    const swallowing = capture === 'all' || armed;

    // What the frame reports, whoever handles the event.
    const pointer = POINTER_TYPES[type];

    if (pointer !== undefined) {
      reportPointer(pointer, event as MouseEvent);
    } else if (
      type === 'pointerout' &&
      (event as MouseEvent).relatedTarget === null
    ) {
      reportPointer('leave', event as MouseEvent);
    } else if (type === 'keydown' || type === 'keyup') {
      const key = event as KeyboardEvent;

      if (
        isCanvasKey(key.key) &&
        (swallowing || key.key === 'Escape' || !isEditable(key.target))
      ) {
        reportKey(key);
      }
    }

    if (type === 'pointerdown') {
      if (armed) {
        // The first press of `first` focuses the preview, nothing more.
        armed = false;
        focusGesture = true;
        swallow(event);

        return;
      }

      focusGesture = false;
    }

    if (focusGesture && GESTURE.has(type)) {
      if (type === 'click') focusGesture = false;
      swallow(event);

      return;
    }

    if (swallowing) swallow(event);
  };

  const onWheel = (event: WheelEvent): void => {
    report({
      kind: 'wheel',
      point: pointOf(event),
      deltaX: numberOf(event.deltaX),
      deltaY: numberOf(event.deltaY),
      deltaMode: intOf(event.deltaMode),
      ...modifiersOf(event),
    });

    if (capture === 'all') swallow(event);
  };

  const onFocus = (event: Event): void => {
    if (event.target === win) report({ kind: 'focus', focused: true });
  };
  const onBlur = (event: Event): void => {
    if (event.target === win) report({ kind: 'focus', focused: false });
  };

  for (const type of SWALLOWED) {
    win.addEventListener(type, onEvent, { capture: true });
  }

  win.addEventListener('wheel', onWheel, { capture: true, passive: false });
  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);

  return {
    setCapture: (next) => {
      capture = next;
      armed = next === 'first';
      focusGesture = false;
    },
    stop: () => {
      for (const type of SWALLOWED) {
        win.removeEventListener(type, onEvent, { capture: true });
      }

      win.removeEventListener('wheel', onWheel, { capture: true });
      win.removeEventListener('focus', onFocus);
      win.removeEventListener('blur', onBlur);
    },
  };
};
