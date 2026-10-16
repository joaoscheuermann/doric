// The viewport math of the papercraft canvas (spec: "O canvas").
//
// Pan and zoom are one CSS `transform` the surface applies to its content;
// the hit-test never reads `document.elementFromPoint` — a transformed canvas
// breaks the direct position test, the Glide lesson — so every question a
// pointer asks goes through the derived tree's cached bounds (see
// `scene-graph.ts`) using the pure helpers below.
//
// All of this is view state, local to a node and to a window: replay must not
// drag the reader back to an old position, so nothing here is durable.

/** One viewport of the canvas: `translate(tx, ty) scale(scale)`. */
export interface Viewport {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

/** No pan, no zoom. */
export const IDENTITY: Viewport = { scale: 1, tx: 0, ty: 0 };

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** One zoom step in or out, as the `−`/`+` controls use it. */
export const ZOOM_STEP = 1.2;

/**
 * Zooms by `factor` keeping `origin` (in surface pixels) stable: what the
 * pointer points at stays under the pointer.
 */
export const zoomAt = (
  viewport: Viewport,
  factor: number,
  origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): Viewport => {
  const scale = clampScale(viewport.scale * factor);
  const ratio = scale / viewport.scale;

  return {
    scale,
    tx: origin.x - (origin.x - viewport.tx) * ratio,
    ty: origin.y - (origin.y - viewport.ty) * ratio,
  };
};

/** One step in (`− 100% +`), keeping the surface centre stable. */
export const zoomStep = (
  viewport: Viewport,
  factor: number,
  area: { readonly width: number; readonly height: number },
): Viewport =>
  zoomAt(viewport, factor, { x: area.width / 2, y: area.height / 2 });

/** A content box, in content coordinates. */
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The `⤢ ajustar` reading: the scale that fits `content` into `area` with a
 * margin, centred, never above identity (fitting means seeing it whole, not
 * blowing a tiny artifact up).
 */
export const fitViewport = (
  content: ContentBounds,
  area: { readonly width: number; readonly height: number },
  margin = 24,
): Viewport => {
  const width = area.width - margin * 2;
  const height = area.height - margin * 2;

  if (width <= 0 || height <= 0) return IDENTITY;
  if (content.width <= 0 || content.height <= 0) return IDENTITY;

  // Never above identity: a fit shows the whole artifact, it does not
  // magnify a small one. Below, the same lower limit as every zoom.
  const scale = clampScale(
    Math.min(1, width / content.width, height / content.height),
  );

  return {
    scale,
    tx: (area.width - content.width * scale) / 2 - content.x * scale,
    ty: (area.height - content.height * scale) / 2 - content.y * scale,
  };
};

/** The toolbar's zoom reading: `100%` at identity. */
export const zoomPercent = (viewport: Viewport): string =>
  `${Math.round(viewport.scale * 100)}%`;

/** A surface point becomes the content point the pointer is over. */
export const toContent = (
  viewport: Viewport,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } => ({
  x: (point.x - viewport.tx) / viewport.scale,
  y: (point.y - viewport.ty) / viewport.scale,
});

/** The CSS transform of one viewport. */
export const viewportTransform = (viewport: Viewport): string =>
  `translate(${viewport.tx}px, ${viewport.ty}px) scale(${viewport.scale})`;

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
