// The viewport math of pan and zoom surfaces (papercraft's canvas, openui's
// diagrams): one CSS `transform` applied to the content, and the wheel rule
// as a pure decision. View state only: nothing here is durable.

/** One viewport of a surface: `translate(tx, ty) scale(scale)`. */
export interface Viewport {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

/** No pan, no zoom. */
export const IDENTITY: Viewport = { scale: 1, tx: 0, ty: 0 };

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

/** `scale` clamped to 0.25–4 (25–400 %). */
export const clampScale = (scale: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** One zoom step in or out, as the `−`/`+` controls use it. */
export const ZOOM_STEP = 1.2;

/**
 * Zooms by `factor` keeping `origin` (in surface pixels) stable: what the
 * pointer points at stays under the pointer. The scale is clamped.
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

/** A content box, in content coordinates. */
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The scale that fits `content` into `area` with `margin` (default 24),
 * centred, never above identity and never below 25 %. `undefined` when the
 * content has no area; `IDENTITY` when the area minus margins has none.
 */
export const fitViewport = (
  content: ContentBounds,
  area: { readonly width: number; readonly height: number },
  margin = 24,
): Viewport | undefined => {
  const width = area.width - margin * 2;
  const height = area.height - margin * 2;

  if (content.width <= 0 || content.height <= 0) return undefined;
  if (width <= 0 || height <= 0) return IDENTITY;

  // Never above identity: a fit shows the whole content, it does not
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

/** One wheel event, as the wheel rule reads it. */
export interface WheelGestureInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
  /** Ctrl or ⌘ held, or a trackpad pinch. */
  readonly zoom: boolean;
  /** The surface takes a plain wheel: it was clicked (focused), or it always does. */
  readonly captured: boolean;
  /** The surface's height in px; 0 counts as 800. */
  readonly pageHeight: number;
}

export type WheelGesture =
  /** Multiply the scale by `factor`, at the pointer. */
  | { readonly kind: 'zoom'; readonly factor: number }
  /** Added to the viewport's translation: −deltaX and −deltaY, scaled. */
  | { readonly kind: 'pan'; readonly dx: number; readonly dy: number };

const WHEEL_ZOOM = 1.1;

/** The px one wheel delta stands for, by its `deltaMode`. */
const deltaScale = (mode: number, pageHeight: number): number =>
  mode === 1 ? 16 : mode === 2 ? pageHeight || 800 : 1;

/**
 * The surface's answer to one wheel event. Pure and total; never throws.
 * - `zoom`: `{ kind: 'zoom', factor: 1.1 }` when `deltaY < 0`, else
 *   `factor: 1 / 1.1` (including `deltaY === 0`), captured or not.
 * - not `zoom`, `captured`: `{ kind: 'pan', dx: −deltaX × s, dy: −deltaY × s }`
 *   with s = 1, 16 or `pageHeight || 800` for `deltaMode` 0, 1, 2.
 * - not `zoom`, not `captured`: `undefined`; the wheel is the page's, and the
 *   caller must not prevent its default.
 */
export const wheelGesture = (
  input: WheelGestureInput,
): WheelGesture | undefined => {
  if (input.zoom) {
    return {
      kind: 'zoom',
      factor: input.deltaY < 0 ? WHEEL_ZOOM : 1 / WHEEL_ZOOM,
    };
  }

  if (!input.captured) return undefined;

  const scale = deltaScale(input.deltaMode, input.pageHeight);

  return { kind: 'pan', dx: -input.deltaX * scale, dy: -input.deltaY * scale };
};
