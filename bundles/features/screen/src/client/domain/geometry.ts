// The floating panel's geometry, stated only in terms of its arguments: the
// panel is kept inside its overlay and never smaller than its floor.

export interface ScreenGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenBounds {
  readonly width: number;
  readonly height: number;
}

export const SCREEN_PANEL_MIN_WIDTH = 280;
export const SCREEN_PANEL_MIN_HEIGHT = 180;
export const SCREEN_PANEL_DEFAULT_WIDTH = 640;
export const SCREEN_PANEL_DEFAULT_HEIGHT = 400;
/** The inset the default geometry keeps from the overlay's corner. */
export const SCREEN_PANEL_INSET = 16;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/** One geometry clamped into the overlay, floor sizes included. */
export const clampGeometry = (
  geometry: ScreenGeometry,
  bounds: ScreenBounds,
): ScreenGeometry => {
  const width = clamp(
    geometry.width,
    SCREEN_PANEL_MIN_WIDTH,
    Math.max(SCREEN_PANEL_MIN_WIDTH, bounds.width),
  );
  const height = clamp(
    geometry.height,
    SCREEN_PANEL_MIN_HEIGHT,
    Math.max(SCREEN_PANEL_MIN_HEIGHT, bounds.height),
  );

  return {
    x: clamp(geometry.x, 0, bounds.width - width),
    y: clamp(geometry.y, 0, bounds.height - height),
    width,
    height,
  };
};

/** The default panel: the overlay's bottom-right corner, inset. */
export const defaultGeometry = (bounds: ScreenBounds): ScreenGeometry =>
  clampGeometry(
    {
      x: bounds.width - SCREEN_PANEL_DEFAULT_WIDTH - SCREEN_PANEL_INSET,
      y: bounds.height - SCREEN_PANEL_DEFAULT_HEIGHT - SCREEN_PANEL_INSET,
      width: SCREEN_PANEL_DEFAULT_WIDTH,
      height: SCREEN_PANEL_DEFAULT_HEIGHT,
    },
    bounds,
  );
