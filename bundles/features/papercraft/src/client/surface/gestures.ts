// `gestures.ts` — the pointer questions of the canvas, and what a click, a
// move, a press, the wheel and the keys do to its view state.
//
// The pointer questions are native listeners on the canvas: a click born
// inside the preview's shadow root crosses the shadow boundary, and the
// delegation React does for its own tree does not reach it. A native
// listener does — and the resolution itself is `composedPath`, then the
// derived tree's cached bounds under the viewport's transform (never
// `document.elementFromPoint`, which a transformed canvas breaks). The wheel
// is the same: a zoom the canvas owns must not scroll the document under it.
//
// The listeners are bound once and read the latest render through a ref, so
// the canvas is never re-bound as the frame re-renders. The keys are React's
// own handlers on the canvas, which owns the space bar and its keys once the
// reader clicked it.

import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from 'react';

import type { CommentAnchor, PreviewTool } from '../../contracts/index.js';
import { anchorOf, pointAnchorOf } from '../anchor.js';
import { anchorIndexOf, type ContentPoint, offsetIn } from './pin-geometry.js';
import { OVERLAY_ATTRIBUTE } from './pins-layer.js';
import type { Scene } from './scene.js';
import { hitTest, nearestNode, type SceneNode } from './scene-graph.js';
import { toContent, type Viewport, zoomAt } from './viewport.js';

export interface GestureInput {
  readonly wrapper: RefObject<HTMLDivElement | null>;
  readonly chrome: 'node' | 'canvas';
  /** Whether the focus is in the frame: the node pans only once clicked. */
  readonly focusedRef: RefObject<boolean>;
  readonly scene: Scene | undefined;
  readonly viewport: Viewport;
  readonly hidden: ReadonlySet<string>;
  readonly tool: PreviewTool;
  /** Whether the frame shows its tools: the window always does. */
  readonly active: boolean;
  readonly spaceHeld: boolean;
  readonly hoverId: string | undefined;
  /** Whether an input or a thread is open over the canvas. */
  readonly inputOpen: boolean;
  readonly canComment: boolean;
  readonly setViewport: Dispatch<SetStateAction<Viewport>>;
  readonly setSpaceHeld: (held: boolean) => void;
  readonly onHover: (id: string | undefined) => void;
  readonly onSelect: (id: string | undefined) => void;
  /** Focuses the canvas and makes it the one the commands act on. */
  readonly focusCanvas: () => void;
  /** A click outside the open input resolves it. */
  readonly resolveInput: () => void;
  /** A click in comment mode: the anchor it resolved to, and the point. */
  readonly onComment: (anchor: CommentAnchor, point: ContentPoint) => void;
}

/** Whether an event came from the overlay (pins, the inline input). */
const fromOverlay = (event: Event): boolean =>
  (typeof event.composedPath === 'function' ? event.composedPath() : []).some(
    (part) => part instanceof Element && part.hasAttribute(OVERLAY_ATTRIBUTE),
  );

/* Pointer questions --------------------------------------------------------- */

const contentPointOf = (
  input: GestureInput,
  event: { readonly clientX: number; readonly clientY: number },
): ContentPoint => {
  const rect = input.wrapper.current?.getBoundingClientRect();

  // Surface pixels, then the inverse of the viewport's transform: the
  // content point the pointer is over, under any pan/zoom.
  return toContent(input.viewport, {
    x: event.clientX - (rect?.x ?? 0),
    y: event.clientY - (rect?.y ?? 0),
  });
};

const nodeOfEvent = (
  input: GestureInput,
  event: Event,
  nearest = true,
): SceneNode | undefined => {
  const scene = input.scene;

  if (scene === undefined) return undefined;

  const path =
    typeof event.composedPath === 'function' ? event.composedPath() : [];

  for (const part of path) {
    if (part === input.wrapper.current) break;
    if (part instanceof Element) {
      const found = scene.graph.nodes.find((node) => node.element === part);

      if (found !== undefined) return found;
    }
  }

  // The pointer missed everything in the path: the derived tree answers —
  // the hit-test under the transform, else the nearest node.
  const pointer = event as unknown as { clientX?: number; clientY?: number };

  if (
    typeof pointer.clientX !== 'number' ||
    typeof pointer.clientY !== 'number'
  )
    return undefined;

  const point = contentPointOf(input, {
    clientX: pointer.clientX,
    clientY: pointer.clientY,
  });

  return (
    hitTest(scene.graph, point, scene.bounds, input.hidden) ??
    (nearest
      ? nearestNode(scene.graph, point, scene.bounds, input.hidden)
      : undefined)
  );
};

/**
 * The element a comment would land on: the one under the pointer, never the
 * document's own body — empty space is a free point — and none at all while
 * `Alt` is held, which forces a free point over an element.
 */
const commentNodeOf = (
  input: GestureInput,
  event: MouseEvent,
): SceneNode | undefined => {
  if (event.altKey) return undefined;

  const node = nodeOfEvent(input, event, false);

  return node === undefined || node.tag === 'body' || node.tag === 'html'
    ? undefined
    : node;
};

const nearestNodeOf = (
  input: GestureInput,
  point: ContentPoint,
): Element | undefined =>
  input.scene === undefined
    ? undefined
    : nearestNode(input.scene.graph, point, input.scene.bounds, input.hidden)
        ?.element;

/* The gestures ---------------------------------------------------------------- */

interface PanDrag {
  readonly x: number;
  readonly y: number;
  readonly tx: number;
  readonly ty: number;
}

interface Gesture {
  panDrag: PanDrag | undefined;
  /** A pointer-down that resolved the open input consumes its click. */
  consumeClick: boolean;
}

/** The click: select, or drop a pin with its inline input. */
const click = (input: GestureInput, gesture: Gesture, event: MouseEvent) => {
  // A click whose element left the document as it was handled (a menu item
  // of an open thread, say) was never a click on the preview.
  if (event.target instanceof Node && !event.target.isConnected) return;
  if (fromOverlay(event)) return;
  if (gesture.consumeClick) {
    gesture.consumeClick = false;

    return;
  }
  if (input.tool === 'pan') return;

  // The preview is being inspected, not used: a link or a submit under the
  // pointer must not navigate the window away.
  event.preventDefault();

  if (input.tool === 'select') {
    input.onSelect(nodeOfEvent(input, event)?.id);

    return;
  }

  if (!input.canComment) return;

  const node = commentNodeOf(input, event);
  const point = contentPointOf(input, event);
  const scene = input.scene;
  const box = node === undefined ? undefined : scene?.bounds(node);
  const anchor =
    node === undefined
      ? pointAnchorOf(point, nearestNodeOf(input, point))
      : anchorOf(
          node.element,
          box === undefined ? undefined : offsetIn(box, point),
          point,
          scene === undefined ? undefined : anchorIndexOf(scene.graph, node),
        );

  input.onComment(anchor, point);
};

/** The armed comment tool follows the pointer to the element it would land on. */
const hover = (input: GestureInput, event: PointerEvent) => {
  if (!input.active || input.tool !== 'comment' || fromOverlay(event)) return;

  const id = commentNodeOf(input, event)?.id;

  if (id !== input.hoverId) input.onHover(id);
};

const pointerDown = (
  input: GestureInput,
  gesture: Gesture,
  event: PointerEvent,
) => {
  if (fromOverlay(event)) return;

  // A click outside the open input resolves it — a note stays as a draft,
  // an empty one is discarded — and that click starts nothing else.
  if (input.inputOpen) {
    gesture.consumeClick = true;
    input.resolveInput();
  }

  // A click is the reader choosing the canvas: it takes the focus (the
  // space bar and, in the node, the wheel are the canvas's from then on)
  // and becomes the canvas a keybinding acts on.
  input.focusCanvas();

  if (!input.spaceHeld && input.tool !== 'pan') return;

  gesture.panDrag = {
    x: event.clientX,
    y: event.clientY,
    tx: input.viewport.tx,
    ty: input.viewport.ty,
  };
  (event.target as Element).setPointerCapture?.(event.pointerId);
};

const panMove = (
  input: GestureInput,
  gesture: Gesture,
  event: PointerEvent,
) => {
  const drag = gesture.panDrag;

  if (drag === undefined) return;

  input.setViewport((current) => ({
    ...current,
    tx: drag.tx + (event.clientX - drag.x),
    ty: drag.ty + (event.clientY - drag.y),
  }));
};

/**
 * Binds the canvas's native listeners once, for the frame's lifetime, and
 * answers whether a pan is under way (the cursor reads it).
 */
export const useCanvasGestures = (
  input: GestureInput,
): { readonly panning: () => boolean } => {
  const latest = useRef(input);
  latest.current = input;
  const gesture = useRef<Gesture>({ panDrag: undefined, consumeClick: false });
  const { wrapper, chrome, focusedRef, setViewport, setSpaceHeld } = input;

  useEffect(() => {
    const area = wrapper.current;

    if (area === null) return;

    const onClick = (event: MouseEvent) =>
      click(latest.current, gesture.current, event);
    const onPointerMove = (event: PointerEvent) => {
      hover(latest.current, event);
      panMove(latest.current, gesture.current, event);
    };
    const onPointerDown = (event: PointerEvent) =>
      pointerDown(latest.current, gesture.current, event);
    const onPointerUp = () => {
      gesture.current.panDrag = undefined;
    };
    const onBlur = () => setSpaceHeld(false);
    const onWheel = (event: WheelEvent): void => {
      const zoom = event.ctrlKey || event.metaKey;

      // An open thread scrolls its own messages.
      if (!zoom && fromOverlay(event)) return;

      // In the conversation the wheel scrolls the conversation: the node pans
      // only once the reader clicked it, and zooms only with the modifier.
      if (chrome === 'node' && !zoom && !focusedRef.current) return;

      event.preventDefault();

      if (zoom) {
        const rect = area.getBoundingClientRect();

        setViewport((current) =>
          zoomAt(current, event.deltaY < 0 ? 1.1 : 1 / 1.1, {
            x: event.clientX - rect.x,
            y: event.clientY - rect.y,
          }),
        );

        return;
      }

      setViewport((current) => ({
        ...current,
        tx: current.tx - event.deltaX,
        ty: current.ty - event.deltaY,
      }));
    };

    area.addEventListener('click', onClick);
    area.addEventListener('pointermove', onPointerMove);
    area.addEventListener('pointerdown', onPointerDown);
    area.addEventListener('pointerup', onPointerUp);
    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('blur', onBlur);

    return () => {
      area.removeEventListener('blur', onBlur);
      area.removeEventListener('click', onClick);
      area.removeEventListener('pointermove', onPointerMove);
      area.removeEventListener('pointerdown', onPointerDown);
      area.removeEventListener('pointerup', onPointerUp);
      area.removeEventListener('wheel', onWheel);
    };
  }, [wrapper, chrome, focusedRef, setViewport, setSpaceHeld]);

  return { panning: () => gesture.current.panDrag !== undefined };
};

/* The keys ------------------------------------------------------------------- */

export interface KeyInput {
  readonly chrome: 'node' | 'canvas';
  readonly tool: PreviewTool;
  /** Whether an input or a thread is open over the canvas. */
  readonly inputOpen: boolean;
  readonly canComment: boolean;
  readonly wrapper: RefObject<HTMLDivElement | null>;
  readonly setSpaceHeld: (held: boolean) => void;
  readonly setCommentMode: (on: boolean) => void;
  readonly closeInput: () => void;
  /** Confirms what the open field holds and sends the stack. */
  readonly sendNow: () => Promise<void>;
}

/**
 * The canvas's keys: space pans, `Cmd/Ctrl+Enter` sends the stack, `Esc`
 * closes what is open, else disarms the comment tool, else (in the node)
 * hands the focus back, and `C` toggles comment mode.
 */
export const canvasKeys = (
  input: KeyInput,
): {
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
  readonly onKeyUp: (event: ReactKeyboardEvent) => void;
} => ({
  onKeyDown: (event) => {
    if (event.key === ' ') {
      event.preventDefault();
      input.setSpaceHeld(true);

      return;
    }

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void input.sendNow();

      return;
    }

    if (event.key === 'Escape') {
      if (input.inputOpen) input.closeInput();
      else if (input.tool === 'comment') input.setCommentMode(false);
      // Nothing left to cancel: the node gives the focus back.
      else if (input.chrome === 'node') input.wrapper.current?.blur?.();

      return;
    }

    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;

    if (plain && (event.key === 'c' || event.key === 'C') && input.canComment) {
      event.preventDefault();
      input.setCommentMode(input.tool !== 'comment');
    }
  },
  onKeyUp: (event) => {
    if (event.key === ' ') input.setSpaceHeld(false);
  },
});
