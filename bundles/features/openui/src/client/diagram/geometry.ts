// Edge ends on round and pointed shapes (openui-diagrams.md F7): ELK ends an
// edge on its node's bounding box, so an end on a diamond or a circle is
// extended along its last segment to the shape's outline.

import type { NodeShape } from './definitions.js';
import type { Box, Point } from './layout-types.js';

/** Halvings of the search along the segment: far below a pixel. */
const STEPS = 60;

/** Where `point` lies against the outline of `shape` in `box`: 1 on it, below 1 inside. */
const reach = (shape: 'diamond' | 'circle', box: Box, point: Point): number => {
  const dx = (point.x - (box.x + box.width / 2)) / (box.width / 2);
  const dy = (point.y - (box.y + box.height / 2)) / (box.height / 2);
  return shape === 'diamond' ? Math.abs(dx) + Math.abs(dy) : Math.hypot(dx, dy);
};

/** `end` moved along the direction from `from` to the outline, or `undefined` when the line misses it. */
const onOutline = (
  from: Point,
  end: Point,
  shape: 'diamond' | 'circle',
  box: Box,
): Point | undefined => {
  const length = Math.hypot(end.x - from.x, end.y - from.y);
  if (length === 0 || box.width <= 0 || box.height <= 0) return undefined;
  const direction = {
    x: (end.x - from.x) / length,
    y: (end.y - from.y) / length,
  };
  const at = (t: number): Point => ({
    x: end.x + direction.x * t,
    y: end.y + direction.y * t,
  });
  // Along the line, the point nearest the centre: inside when the line meets the shape.
  const nearest =
    (box.x + box.width / 2 - end.x) * direction.x +
    (box.y + box.height / 2 - end.y) * direction.y;
  if (nearest <= 0 || reach(shape, box, at(nearest)) > 1) return undefined;
  if (reach(shape, box, end) <= 1) return undefined;

  let outside = 0;
  let inside = nearest;
  for (let step = 0; step < STEPS; step += 1) {
    const middle = (outside + inside) / 2;
    if (reach(shape, box, at(middle)) > 1) outside = middle;
    else inside = middle;
  }
  return at((outside + inside) / 2);
};

/**
 * `points` with its first (`at: 'start'`) or last segment extended along its
 * direction to the outline of a diamond or circle inscribed in `box`;
 * unchanged (same values) for other shapes, or when fewer than 2 points.
 * Pure; never mutates `points`.
 */
export const endOnShape = (
  points: readonly Point[],
  at: 'start' | 'end',
  shape: NodeShape,
  box: Box,
): readonly Point[] => {
  if ((shape !== 'diamond' && shape !== 'circle') || points.length < 2) {
    return points;
  }
  const last = points.length - 1;
  const [from, end] =
    at === 'start' ? [points[1], points[0]] : [points[last - 1], points[last]];
  if (from === undefined || end === undefined) return points;
  const moved = onOutline(from, end, shape, box);
  if (moved === undefined) return points;
  return points.map((point, i) =>
    i === (at === 'start' ? 0 : last) ? moved : point,
  );
};
