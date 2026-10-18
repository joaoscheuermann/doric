// `overlays.tsx` — what the canvas draws over the content, in surface pixels:
// the element the armed comment tool would land on (a dashed outline and a
// label naming the element and its source line), and the selection (a solid
// outline). Both read a node's cached bounds through the viewport.

import type { BoundsOf, SceneNode } from './scene-graph.js';
import { nodeLabel } from './scene-graph.js';
import type { Viewport } from './viewport.js';

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 } as const;

/** The label the armed comment tool shows over an element: `button#pay · Checkout.tsx:42`. */
export const hoverLabelOf = (node: SceneNode): string => {
  const element = nodeLabel(node);

  if (node.stamp === undefined) return element;

  const file = node.stamp.path.split('/').pop() ?? node.stamp.path;

  return node.stamp.line === undefined
    ? `${element} · ${file}`
    : `${element} · ${file}:${String(node.stamp.line)}`;
};

const outlineOf = (
  node: SceneNode,
  bounds: BoundsOf | undefined,
  viewport: Viewport,
) => {
  const box = bounds?.(node) ?? EMPTY_BOUNDS;

  return {
    left: `${String(box.x * viewport.scale + viewport.tx)}px`,
    top: `${String(box.y * viewport.scale + viewport.ty)}px`,
    width: `${String(box.width * viewport.scale)}px`,
    height: `${String(box.height * viewport.scale)}px`,
  };
};

/** The hover label sits on the outline's top edge, inside the canvas. */
const labelPlacement = (
  node: SceneNode,
  bounds: BoundsOf | undefined,
  viewport: Viewport,
) => {
  const box = bounds?.(node) ?? EMPTY_BOUNDS;
  const left = box.x * viewport.scale + viewport.tx;
  const top = box.y * viewport.scale + viewport.ty;

  return {
    left: `${String(Math.max(4, left))}px`,
    top: `${String(top >= 22 ? top - 20 : top + box.height * viewport.scale + 4)}px`,
  };
};

/**
 * The element under the pointer, in any mode — what the armed comment lands
 * on, before the click: a dashed outline, never the selection's solid one,
 * and a label naming the element and the source line it came from — the
 * label only while nothing is open over the canvas, so it never covers the
 * input, its pending pin or a thread.
 */
export function HoverOutline({
  node,
  bounds,
  viewport,
  withLabel,
}: {
  readonly node: SceneNode;
  readonly bounds: BoundsOf | undefined;
  readonly viewport: Viewport;
  readonly withLabel: boolean;
}) {
  return (
    <>
      <div
        data-testid="papercraft-hover"
        className="pointer-events-none absolute z-10 rounded-sm border-[1.5px] border-dashed border-primary"
        style={outlineOf(node, bounds, viewport)}
      />
      {withLabel ? (
        <span
          data-testid="papercraft-hover-label"
          className="pointer-events-none absolute z-10 rounded-sm bg-primary px-1.5 font-mono text-[10.5px] leading-4 whitespace-nowrap text-primary-foreground"
          style={labelPlacement(node, bounds, viewport)}
        >
          {hoverLabelOf(node)}
        </span>
      ) : null}
    </>
  );
}

/** The selection: the element with its outline. */
export function SelectionOutline({
  node,
  bounds,
  viewport,
}: {
  readonly node: SceneNode;
  readonly bounds: BoundsOf | undefined;
  readonly viewport: Viewport;
}) {
  return (
    <div
      data-testid="papercraft-selection"
      className="pointer-events-none absolute z-10 border-2 border-primary"
      style={outlineOf(node, bounds, viewport)}
    />
  );
}
