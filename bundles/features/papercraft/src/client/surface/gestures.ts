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
import {
  hitTest,
  nearestNode,
  pseudoAt,
  type SceneNode,
  type SceneTarget,
  targetBounds,
  targetIdOf,
} from './scene-graph.js';
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

/** The client point of an event, when it has one (a pointer or mouse event). */
const clientPointOf = (
  event: Event,
): { readonly clientX: number; readonly clientY: number } | undefined => {
  const pointer = event as unknown as { clientX?: number; clientY?: number };

  return typeof pointer.clientX === 'number' &&
    typeof pointer.clientY === 'number'
    ? { clientX: pointer.clientX, clientY: pointer.clientY }
    : undefined;
};

const hostOfEvent = (
  input: GestureInput,
  scene: Scene,
  event: Event,
  nearest: boolean,
): SceneNode | undefined => {
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
  const client = clientPointOf(event);

  if (client === undefined) return undefined;

  const point = contentPointOf(input, client);

  return (
    hitTest(scene.graph, point, scene.bounds, input.hidden) ??
    (nearest
      ? nearestNode(scene.graph, point, scene.bounds, input.hidden)
      : undefined)
  );
};

/**
 * The target under the pointer: the node, resolved from the event's path,
 * else the hit-test, else (when `nearest`) the nearest node — or the node's
 * out-of-flow `::before` / `::after` when the pointer lies on its box.
 */
const targetOfEvent = (
  input: GestureInput,
  event: Event,
  nearest = true,
): SceneTarget | undefined => {
  const scene = input.scene;

  if (scene === undefined) return undefined;

  const node = hostOfEvent(input, scene, event, nearest);

  if (node === undefined) return undefined;

  const client = clientPointOf(event);
  const pseudo =
    client === undefined
      ? undefined
      : pseudoAt(node, contentPointOf(input, client), scene.pseudoBounds);

  return { node, pseudo };
};

/**
 * The target under the pointer, never the document's own body: empty space
 * points at nothing.
 */
const pointedTargetOf = (
  input: GestureInput,
  event: MouseEvent,
): SceneTarget | undefined => {
  const target = targetOfEvent(input, event, false);

  return target === undefined ||
    target.node.tag === 'body' ||
    target.node.tag === 'html'
    ? undefined
    : target;
};

/**
 * The target a comment would land on: the one under the pointer — empty
 * space is a free point — and none at all while `Alt` is held, which forces
 * a free point over an element.
 */
const commentTargetOf = (
  input: GestureInput,
  event: MouseEvent,
): SceneTarget | undefined =>
  event.altKey ? undefined : pointedTargetOf(input, event);

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
    const target = targetOfEvent(input, event);

    input.onSelect(target === undefined ? undefined : targetIdOf(target));

    return;
  }

  if (!input.canComment) return;

  const target = commentTargetOf(input, event);
  const point = contentPointOf(input, event);
  const scene = input.scene;
  const anchor =
    target === undefined
      ? pointAnchorOf(point, nearestNodeOf(input, point))
      : anchorOf(
          target.node.element,
          scene === undefined
            ? undefined
            : offsetIn(
                targetBounds(target, scene.bounds, scene.pseudoBounds),
                point,
              ),
          point,
          scene === undefined
            ? undefined
            : anchorIndexOf(scene.graph, target.node),
          target.pseudo,
        );

  input.onComment(anchor, point);
};

/**
 * The outline follows the pointer in any mode, focused or not: to the
 * element a comment would land on while the comment tool is armed, else to
 * the element under the pointer. Nothing is outlined while the canvas pans.
 */
const hover = (input: GestureInput, gesture: Gesture, event: PointerEvent) => {
  if (fromOverlay(event)) return;

  const panning =
    input.tool === 'pan' || input.spaceHeld || gesture.panDrag !== undefined;
  const target = panning
    ? undefined
    : input.tool === 'comment'
      ? commentTargetOf(input, event)
      : pointedTargetOf(input, event);
  const id = target === undefined ? undefined : targetIdOf(target);

  if (id !== input.hoverId) input.onHover(id);
};

/** The pointer left the canvas: nothing stays outlined. */
const leave = (input: GestureInput) => {
  if (input.hoverId !== undefined) input.onHover(undefined);
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
      hover(latest.current, gesture.current, event);
      panMove(latest.current, gesture.current, event);
    };
    const onPointerLeave = () => leave(latest.current);
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
    area.addEventListener('pointerleave', onPointerLeave);
    area.addEventListener('pointerdown', onPointerDown);
    area.addEventListener('pointerup', onPointerUp);
    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('blur', onBlur);

    return () => {
      area.removeEventListener('blur', onBlur);
      area.removeEventListener('click', onClick);
      area.removeEventListener('pointermove', onPointerMove);
      area.removeEventListener('pointerleave', onPointerLeave);
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
}

/**
 * The canvas's keys: space pans, `Esc` closes what is open, else disarms the
 * comment tool, else (in the node) hands the focus back, and `C` toggles
 * comment mode. `Cmd/Ctrl+Enter` is the window's send chord, not the canvas's:
 * chat's in the conversation, `papercraft.send/v1` in the canvas window.
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
