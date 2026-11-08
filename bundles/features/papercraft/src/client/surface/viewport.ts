// The viewport math of the papercraft canvas (spec: "O canvas").
//
// Pan and zoom are one CSS `transform` the surface applies to its content;
// the hit-test never reads `document.elementFromPoint` — a transformed canvas
// breaks the direct position test, the Glide lesson — so every question a
// pointer asks goes through the derived tree's cached bounds (see
// `scene-graph.ts`) using the pure helpers re-exported below from
// `desktop/ui/viewport`, shared with openui's diagrams. The dot grid stays here.
//
// All of this is view state, local to a node and to a window: replay must not
// drag the reader back to an old position, so nothing here is durable.

export {
  type ContentBounds,
  clampScale,
  fitViewport,
  IDENTITY,
  toContent,
  type Viewport,
  viewportTransform,
  ZOOM_STEP,
  zoomAt,
  zoomPercent,
} from 'desktop/ui/viewport';

import type { Viewport } from 'desktop/ui/viewport';

/** The dot grid's step at identity, in content pixels. */
export const GRID_STEP = 24;

/** Every how many steps a major dot falls. */
export const GRID_MAJOR_EVERY = 4;

/** Below this on-screen step the minor dots crowd into noise and hide. */
const GRID_MIN_MINOR_STEP = 8;

const MINOR_DOT = 'var(--border)';
const MAJOR_DOT =
  'color-mix(in oklab, var(--muted-foreground) 45%, transparent)';

/**
 * The canvas background: a dot where each grid line would cross, a minor dot
 * every step and a stronger one every `GRID_MAJOR_EVERY`. The grid is laid in
 * content coordinates, so it pans and zooms with the content; the dots keep
 * their size on screen. The background colour stays the container's.
 */
export const gridBackground = (
  viewport: Viewport,
): {
  readonly backgroundImage: string;
  readonly backgroundSize: string;
  readonly backgroundPosition: string;
} => {
  const minor = GRID_STEP * viewport.scale;
  const major = minor * GRID_MAJOR_EVERY;

  // A tile draws its dot at its centre, so each tile starts half a step
  // before the crossing it marks; content (0, 0) is a major crossing.
  const at = (step: number) =>
    `${String(viewport.tx - step / 2)}px ${String(viewport.ty - step / 2)}px`;
  const dot = (color: string, radius: number) =>
    `radial-gradient(circle, ${color} ${String(radius)}px, transparent ${String(radius + 0.5)}px)`;

  const layers = [{ image: dot(MAJOR_DOT, 1.25), step: major }];

  if (minor >= GRID_MIN_MINOR_STEP) {
    layers.push({ image: dot(MINOR_DOT, 1), step: minor });
  }

  return {
    backgroundImage: layers.map((layer) => layer.image).join(', '),
    backgroundSize: layers
      .map((layer) => `${String(layer.step)}px ${String(layer.step)}px`)
      .join(', '),
    backgroundPosition: layers.map((layer) => at(layer.step)).join(', '),
  };
};
