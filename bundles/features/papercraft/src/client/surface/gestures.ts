// `gestures.ts` — the pointer questions of the canvas, and what a click, a
// move, a press, the wheel and the keys do to its view state.
//
// The pointer reaches the canvas two ways. Over the canvas's own elements
// (the empty space around the preview, the overlay) as native events on the
// canvas. Over the preview, as the reports of its sandboxed frame: the frame
// owns its document's events, swallows them while the canvas's tools capture
// the input, and reports each one with the content point (the frame's CSS
// pixels are content coordinates: the iframe sits at the content origin under
// the viewport's transform) and the scene node it resolved the event's target
// to. Both become one pointer here, so hover, selection, comments and pan
// answer the same wherever the pointer is.
//
// The target is the frame's node when it named one, else the derived tree's
// cached bounds under the viewport's transform (never
// `document.elementFromPoint`, which a transformed canvas breaks). The wheel
// is the same: a zoom the canvas owns must not scroll the document under it.
//
// The listeners are bound once and read the latest render through a ref, so
// the canvas is never re-bound as the frame re-renders. The keys are React's
// own handlers on the canvas, which owns the space bar and its keys once the
// reader clicked it, and the keys the frame reports while it has the focus.

import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
} from 'react';

import type { CommentAnchor, PreviewTool } from '../../contracts/index.js';
import { anchorOf, pointAnchorOf } from '../anchor.js';
import type { FrameMessage } from '../frame-protocol.js';
import { anchorIndexOf, type ContentPoint, offsetIn } from './pin-geometry.js';
import { OVERLAY_ATTRIBUTE } from './pins-layer.js';
import type { Scene } from './scene.js';
import {
  hitTest,
  nearestNode,
  type PseudoKind,
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

type FramePointer = Extract<FrameMessage, { kind: 'pointer' }>;
type FrameWheel = Extract<FrameMessage, { kind: 'wheel' }>;

/** One pointer event of the canvas, from the app's DOM or from the frame. */
interface CanvasPointer {
  /** Where it is on the canvas, in surface pixels. */
  readonly surface: ContentPoint;
  /** The content point under it, under any pan/zoom. */
  readonly content: ContentPoint;
  /** The scene node the frame resolved its target to. */
  readonly nodeId?: string;
  readonly pseudo?: PseudoKind;
  readonly altKey: boolean;
  /** It came from the overlay (pins, the inline input). */
  readonly fromOverlay: boolean;
  /** Keeps a link or a submit under the pointer from acting. */
  readonly preventDefault: () => void;
}

/** Whether an event came from the overlay (pins, the inline input). */
const fromOverlay = (event: Event): boolean =>
  (typeof event.composedPath === 'function' ? event.composedPath() : []).some(
    (part) => part instanceof Element && part.hasAttribute(OVERLAY_ATTRIBUTE),
  );

/** The surface point of an event, relative to the canvas. */
const surfaceOf = (
  input: GestureInput,
  event: { readonly clientX: number; readonly clientY: number },
): ContentPoint => {
  const rect = input.wrapper.current?.getBoundingClientRect();

  return {
    x: event.clientX - (rect?.x ?? 0),
    y: event.clientY - (rect?.y ?? 0),
  };
};

/** The surface point a content point is drawn at. */
const toSurface = (viewport: Viewport, point: ContentPoint): ContentPoint => ({
  x: point.x * viewport.scale + viewport.tx,
  y: point.y * viewport.scale + viewport.ty,
});

/** A native event of the canvas, as one pointer. */
const nativePointer = (
  input: GestureInput,
  event: MouseEvent,
): CanvasPointer => {
  const surface = surfaceOf(input, event);

  // Surface pixels, then the inverse of the viewport's transform: the
  // content point the pointer is over, under any pan/zoom.
  return {
    surface,
    content: toContent(input.viewport, surface),
    altKey: event.altKey,
    fromOverlay: fromOverlay(event),
    preventDefault: () => event.preventDefault(),
  };
};

/**
 * A pointer the frame reported, as one pointer. The frame already swallowed
 * the event while the canvas captures the input, so nothing is left to
 * prevent.
 */
const reportedPointer = (
  input: GestureInput,
  message: FramePointer | FrameWheel,
): CanvasPointer => ({
  surface: toSurface(input.viewport, message.point),
  content: message.point,
  ...('nodeId' in message && message.nodeId !== undefined
    ? { nodeId: message.nodeId }
    : {}),
  ...('pseudo' in message && message.pseudo !== undefined
    ? { pseudo: message.pseudo }
    : {}),
  altKey: message.altKey,
  fromOverlay: false,
  preventDefault: () => undefined,
});

/* Pointer questions --------------------------------------------------------- */

/**
 * The node under the pointer: the one the frame resolved the event to, else
 * the hit-test under the transform, else (when `nearest`) the nearest node.
 */
const hostOf = (
  input: GestureInput,
  scene: Scene,
  pointer: CanvasPointer,
  nearest: boolean,
): SceneNode | undefined => {
  const named =
    pointer.nodeId === undefined
      ? undefined
      : scene.graph.byId.get(pointer.nodeId);

  if (named !== undefined) return named;

  return (
    hitTest(scene.graph, pointer.content, scene.bounds, input.hidden) ??
    (nearest
      ? nearestNode(scene.graph, pointer.content, scene.bounds, input.hidden)
      : undefined)
  );
};

/**
 * The target under the pointer: its node, or the node's out-of-flow
 * `::before` / `::after` when the pointer lies on its box (as the frame says,
 * else as the scene's pseudo boxes do).
 */
const targetOf = (
  input: GestureInput,
  pointer: CanvasPointer,
  nearest = true,
): SceneTarget | undefined => {
  const scene = input.scene;

  if (scene === undefined) return undefined;

  const node = hostOf(input, scene, pointer, nearest);

  if (node === undefined) return undefined;

  const pseudo =
    (pointer.nodeId === node.id ? pointer.pseudo : undefined) ??
    pseudoAt(node, pointer.content, scene.pseudoBounds);

  return { node, pseudo };
};

/**
 * The target under the pointer, never the document's own body: empty space
 * points at nothing.
 */
const pointedTargetOf = (
  input: GestureInput,
  pointer: CanvasPointer,
): SceneTarget | undefined => {
  const target = targetOf(input, pointer, false);

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
  pointer: CanvasPointer,
): SceneTarget | undefined =>
  pointer.altKey ? undefined : pointedTargetOf(input, pointer);

const nearestNodeOf = (
  input: GestureInput,
  point: ContentPoint,
): SceneNode | undefined =>
  input.scene === undefined
    ? undefined
    : nearestNode(input.scene.graph, point, input.scene.bounds, input.hidden);

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
const click = (
  input: GestureInput,
  gesture: Gesture,
  pointer: CanvasPointer,
) => {
  if (pointer.fromOverlay) return;
  if (gesture.consumeClick) {
    gesture.consumeClick = false;

    return;
  }
  if (input.tool === 'pan') return;

  // The preview is being inspected, not used: a link or a submit under the
  // pointer must not act.
  pointer.preventDefault();

  if (input.tool === 'select') {
    const target = targetOf(input, pointer);

    input.onSelect(target === undefined ? undefined : targetIdOf(target));

    return;
  }

  if (!input.canComment) return;

  const target = commentTargetOf(input, pointer);
  const point = pointer.content;
  const scene = input.scene;
  const anchor =
    target === undefined
      ? pointAnchorOf(point, nearestNodeOf(input, point))
      : anchorOf(
          target.node,
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
const hover = (
  input: GestureInput,
  gesture: Gesture,
  pointer: CanvasPointer,
) => {
  if (pointer.fromOverlay) return;

  const panning =
    input.tool === 'pan' || input.spaceHeld || gesture.panDrag !== undefined;
  const target = panning
    ? undefined
    : input.tool === 'comment'
      ? commentTargetOf(input, pointer)
      : pointedTargetOf(input, pointer);
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
  pointer: CanvasPointer,
): boolean => {
  if (pointer.fromOverlay) return false;

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

  if (!input.spaceHeld && input.tool !== 'pan') return false;

  gesture.panDrag = {
    x: pointer.surface.x,
    y: pointer.surface.y,
    tx: input.viewport.tx,
    ty: input.viewport.ty,
  };

  return true;
};

const panMove = (
  input: GestureInput,
  gesture: Gesture,
  pointer: CanvasPointer,
) => {
  const drag = gesture.panDrag;

  if (drag === undefined) return;

  input.setViewport((current) => ({
    ...current,
    tx: drag.tx + (pointer.surface.x - drag.x),
    ty: drag.ty + (pointer.surface.y - drag.y),
  }));
};

/** The px one wheel delta stands for, by its `deltaMode`. */
const deltaScale = (mode: number, area: HTMLElement | null): number =>
  mode === 1 ? 16 : mode === 2 ? (area?.clientHeight ?? 0) || 800 : 1;

interface WheelInput {
  readonly surface: ContentPoint;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly zoom: boolean;
  readonly fromOverlay: boolean;
  readonly preventDefault: () => void;
}

const wheel = (input: GestureInput, event: WheelInput): void => {
  // An open thread scrolls its own messages.
  if (!event.zoom && event.fromOverlay) return;

  // In the conversation the wheel scrolls the conversation: the node pans
  // only once the reader clicked it, and zooms only with the modifier.
  if (input.chrome === 'node' && !event.zoom && !input.focusedRef.current)
    return;

  event.preventDefault();

  if (event.zoom) {
    input.setViewport((current) =>
      zoomAt(current, event.deltaY < 0 ? 1.1 : 1 / 1.1, event.surface),
    );

    return;
  }

  const factor = deltaScale(event.deltaMode, input.wrapper.current);

  input.setViewport((current) => ({
    ...current,
    tx: current.tx - event.deltaX * factor,
    ty: current.ty - event.deltaY * factor,
  }));
};

/**
 * Binds the canvas's native listeners once, for the frame's lifetime, and
 * answers whether a pan is under way (the cursor reads it), and how the
 * frame's pointer and wheel reports act on the canvas.
 */
export const useCanvasGestures = (
  input: GestureInput,
): {
  readonly panning: () => boolean;
  /** A pointer report of the preview's frame. */
  readonly framePointer: (message: FramePointer) => void;
  /** A wheel report of the preview's frame. */
  readonly frameWheel: (message: FrameWheel) => void;
} => {
  const latest = useRef(input);
  latest.current = input;
  const gesture = useRef<Gesture>({ panDrag: undefined, consumeClick: false });
  const { wrapper, setSpaceHeld } = input;

  useEffect(() => {
    const area = wrapper.current;

    if (area === null) return;

    const onClick = (event: MouseEvent) => {
      // A click whose element left the document as it was handled (a menu
      // item of an open thread, say) was never a click on the preview.
      if (event.target instanceof Node && !event.target.isConnected) return;
      click(
        latest.current,
        gesture.current,
        nativePointer(latest.current, event),
      );
    };
    const onPointerMove = (event: PointerEvent) => {
      const pointer = nativePointer(latest.current, event);

      hover(latest.current, gesture.current, pointer);
      panMove(latest.current, gesture.current, pointer);
    };
    const onPointerLeave = () => leave(latest.current);
    const onPointerDown = (event: PointerEvent) => {
      if (
        pointerDown(
          latest.current,
          gesture.current,
          nativePointer(latest.current, event),
        )
      )
        (event.target as Element).setPointerCapture?.(event.pointerId);
    };
    const onPointerUp = () => {
      gesture.current.panDrag = undefined;
    };
    const onBlur = () => setSpaceHeld(false);
    const onWheel = (event: WheelEvent): void =>
      wheel(latest.current, {
        surface: surfaceOf(latest.current, event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        zoom: event.ctrlKey || event.metaKey,
        fromOverlay: fromOverlay(event),
        preventDefault: () => event.preventDefault(),
      });

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
  }, [wrapper, setSpaceHeld]);

  const handlers = useRef({
    framePointer: (message: FramePointer): void => {
      const current = latest.current;
      const pointer = reportedPointer(current, message);

      switch (message.type) {
        case 'move':
          hover(current, gesture.current, pointer);
          panMove(current, gesture.current, pointer);

          return;
        case 'down':
          pointerDown(current, gesture.current, pointer);

          return;
        case 'up':
          gesture.current.panDrag = undefined;

          return;
        case 'click':
          click(current, gesture.current, pointer);

          return;
        case 'leave':
          leave(current);

          return;
      }
    },
    frameWheel: (message: FrameWheel): void => {
      const current = latest.current;

      wheel(current, {
        surface: toSurface(current.viewport, message.point),
        deltaX: message.deltaX,
        deltaY: message.deltaY,
        deltaMode: message.deltaMode,
        zoom: message.ctrlKey || message.metaKey,
        fromOverlay: false,
        // The frame prevents its own scroll while the canvas captures it.
        preventDefault: () => undefined,
      });
    },
  });

  return {
    panning: () => gesture.current.panDrag !== undefined,
    framePointer: handlers.current.framePointer,
    frameWheel: handlers.current.frameWheel,
  };
};

/* The keys ------------------------------------------------------------------- */

export interface KeyInput {
  readonly chrome: 'node' | 'canvas';
  readonly tool: PreviewTool;
  /** Whether an input or a thread is open over the canvas. */
  readonly inputOpen: boolean;
  readonly canComment: boolean;
  /** Hands the focus back: the node lets go of it. */
  readonly release: () => void;
  readonly setSpaceHeld: (held: boolean) => void;
  readonly setCommentMode: (on: boolean) => void;
  readonly closeInput: () => void;
}

/**
 * What the keys read of a key event: React's own on the canvas, or the
 * frame's `key` report while the preview has the focus.
 */
export interface CanvasKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly preventDefault: () => void;
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
  readonly onKeyDown: (event: CanvasKey) => void;
  readonly onKeyUp: (event: CanvasKey) => void;
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
      else if (input.chrome === 'node') input.release();

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
