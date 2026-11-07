// The drawn mind map (openui-diagrams-phase2.md F20): topics as round shapes
// with their labels, joined by ELK's routes without arrowheads.

import type { ReactNode } from 'react';

import { fill, Label, stroke } from './canvas.js';
import type { LayoutResult } from './layout-types.js';
import type { MindMapSizes } from './measure.js';
import type { MindMapModel } from './mindmap-model.js';
import { mindMapOutline } from './outline.js';

/**
 * One `svg[role="img"]`, `result.width` × `result.height`, `aria-label`
 * `mindMapOutline(model).header`, `aria-describedby={outlineId}`. Topics as `round` shapes with
 * their labels (the root `group2`, others `nodeFill`; an empty label an empty box); edges as
 * polylines through ELK's points, without arrowheads. `sizes` and `result` must come from this model.
 */
export function MindMapPicture(props: {
  readonly model: MindMapModel;
  readonly sizes: MindMapSizes;
  readonly result: LayoutResult;
  readonly outlineId: string;
}): ReactNode {
  const { model, sizes, result, outlineId } = props;
  // Topic i in preorder is `n<i>`, and the edge to it `e<i>` (graph.ts); the root has none.
  const topics = sizes.topics;
  return (
    <svg
      role="img"
      aria-label={mindMapOutline(model).header}
      aria-describedby={outlineId}
      width={result.width}
      height={result.height}
      viewBox={`0 0 ${result.width} ${result.height}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {topics.map((_, i) => {
        const key = `e${i}`;
        const points = result.edges[key]?.points;
        return points === undefined || points.length < 2 ? null : (
          <polyline
            key={key}
            points={points.map(({ x, y }) => `${x},${y}`).join(' ')}
            fill="none"
            style={{ ...stroke('edge'), strokeWidth: 1.5 }}
          />
        );
      })}
      {topics.map((size, i) => {
        const key = `n${i}`;
        const box = result.nodes[key];
        if (box === undefined) return null;
        return (
          <g key={key}>
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={box.height / 2}
              style={{
                ...fill(i === 0 ? 'group2' : 'nodeFill'),
                ...stroke('nodeStroke'),
                strokeWidth: 1.5,
              }}
            />
            <Label
              block={size.label}
              x={box.x + box.width / 2}
              y={box.y + box.height / 2}
              color="nodeText"
            />
          </g>
        );
      })}
    </svg>
  );
}
