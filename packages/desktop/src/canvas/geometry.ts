// `geometry.ts` — the coordinates every canvas speaks: a point and a box in
// content coordinates (the content's own CSS pixels, before pan and zoom).

/** A point in content coordinates. */
export interface ContentPoint {
  readonly x: number;
  readonly y: number;
}

/** A content box, in content coordinates. */
export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
