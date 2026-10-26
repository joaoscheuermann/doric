// `overlays.tsx` — what the canvas draws over the content, in surface pixels:
// the target the armed comment tool would land on (a dashed outline and a
// label naming the element, or its pseudo-element, and its source line), and
// the selection (a solid outline). Both draw a box in content coordinates
// through the viewport.

import type { Bounds, SceneTarget } from './scene-graph.js';
import { targetLabel } from './scene-graph.js';
import type { Viewport } from './viewport.js';

/** The label the armed comment tool shows over a target: `button#pay · Checkout.tsx:42`, `span.badge::after · Checkout.tsx:42`. It is `targetLabel(target)`, followed by ` · ` and the host stamp's file name (and `:line`) when the host is stamped. A pseudo-element shares its host's stamp. Pure. */
export const hoverLabelOf = (target: SceneTarget): string => {
  const element = targetLabel(target);
  const { stamp } = target.node;

  if (stamp === undefined) return element;

  const file = stamp.path.split('/').pop() ?? stamp.path;

  return stamp.line === undefined
    ? `${element} · ${file}`
    : `${element} · ${file}:${String(stamp.line)}`;
};

const outlineOf = (box: Bounds, viewport: Viewport) => ({
  left: `${String(box.x * viewport.scale + viewport.tx)}px`,
  top: `${String(box.y * viewport.scale + viewport.ty)}px`,
  width: `${String(box.width * viewport.scale)}px`,
  height: `${String(box.height * viewport.scale)}px`,
});

/** The hover label sits on the outline's top edge, inside the canvas. */
const labelPlacement = (box: Bounds, viewport: Viewport) => {
  const left = box.x * viewport.scale + viewport.tx;
  const top = box.y * viewport.scale + viewport.ty;

  return {
    left: `${String(Math.max(4, left))}px`,
    top: `${String(top >= 22 ? top - 20 : top + box.height * viewport.scale + 4)}px`,
  };
};

/**
 * The target under the pointer, in any mode — what the armed comment lands
 * on, before the click: a dashed outline, never the selection's solid one,
 * and a label naming the target and the source line it came from — the
 * label only while nothing is open over the canvas, so it never covers the
 * input, its pending pin or a thread. `box` is in content coordinates,
 * normally `targetBounds(target, …)`.
 */
export function HoverOutline({
  target,
  box,
  viewport,
  withLabel,
}: {
  readonly target: SceneTarget;
  readonly box: Bounds;
  readonly viewport: Viewport;
  readonly withLabel: boolean;
}) {
  return (
    <>
      <div
        data-testid="papercraft-hover"
        className="pointer-events-none absolute z-10 rounded-sm border-[1.5px] border-dashed border-primary"
        style={outlineOf(box, viewport)}
      />
      {withLabel ? (
        <span
          data-testid="papercraft-hover-label"
          className="pointer-events-none absolute z-10 rounded-sm bg-primary px-1.5 font-mono text-[10.5px] leading-4 whitespace-nowrap text-primary-foreground"
          style={labelPlacement(box, viewport)}
        >
          {hoverLabelOf(target)}
        </span>
      ) : null}
    </>
  );
}

/** The selection: the selected target's box, in content coordinates, outlined. */
export function SelectionOutline({
  box,
  viewport,
}: {
  readonly box: Bounds;
  readonly viewport: Viewport;
}) {
  return (
    <div
      data-testid="papercraft-selection"
      className="pointer-events-none absolute z-10 border-2 border-primary"
      style={outlineOf(box, viewport)}
    />
  );
}
