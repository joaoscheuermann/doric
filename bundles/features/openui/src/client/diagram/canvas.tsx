// The drawn diagram (openui-diagrams.md F7, F8): one SVG drawn by React from
// a laid-out model, in an area that pans and zooms when the diagram is
// interactive and shows the fit otherwise.

import { viewportTransform } from 'desktop/ui/viewport';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { type ColorRole, cssColor, DIAGRAM_COLORS } from './colors.js';
import { endOnShape } from './geometry.js';
import { useDiagramViewport } from './gestures.js';
import type { Box, LayoutResult, Point } from './layout-types.js';
import {
  CYLINDER_CAP,
  DIAGRAM_METRICS,
  type Sizes,
  type TextBlock,
} from './measure.js';
import type { FlowchartModel, FlowEdge, FlowNode } from './model.js';
import { outlineHeader } from './outline.js';

/** The fit's margin around the drawing, as `fitViewport` keeps it. */
const FIT_MARGIN = 24;

/** The area's height bounds: with `height` written, and from the fitted drawing. */
const WRITTEN_HEIGHT = { min: 160, max: 1200 } as const;
const FITTED_HEIGHT = { min: 160, max: 560 } as const;

const clamp = (value: number, bounds: { min: number; max: number }) =>
  Math.min(bounds.max, Math.max(bounds.min, value));

/**
 * The area's height: `height` clamped to 160–1200 px when written, else the
 * drawing at the scale that fits the area's width, plus the fit margin,
 * clamped to 160–560 px.
 */
const areaHeight = (
  written: number | undefined,
  result: { readonly width: number; readonly height: number },
  areaWidth: number,
): number => {
  if (written !== undefined) return clamp(written, WRITTEN_HEIGHT);
  const room = areaWidth - 2 * FIT_MARGIN;
  const scale =
    room > 0 && result.width > 0 ? Math.min(1, room / result.width) : 1;
  return clamp(result.height * scale + 2 * FIT_MARGIN, FITTED_HEIGHT);
};

/** `{ fill: <role's CSS color> }`. */
export const fill = (role: ColorRole): CSSProperties => ({
  fill: cssColor(DIAGRAM_COLORS[role]),
});
/** `{ stroke: <role's CSS color> }`. */
export const stroke = (role: ColorRole): CSSProperties => ({
  stroke: cssColor(DIAGRAM_COLORS[role]),
});

/** A group's fill by its depth, 1 to 4. */
const GROUP_FILLS: readonly ColorRole[] = [
  'group1',
  'group2',
  'group3',
  'group4',
];

/** The fit's text style: the conversation's face at `DIAGRAM_METRICS` size and weight. */
export const TEXT_STYLE: CSSProperties = {
  fontFamily: 'var(--font-conversation)',
  fontSize: DIAGRAM_METRICS.fontSize,
  fontWeight: DIAGRAM_METRICS.fontWeight,
};

/** A label's lines centred on (`x`, `y`), one `<text>` per line, in `color`. */
export function Label(props: {
  readonly block: TextBlock;
  readonly x: number;
  readonly y: number;
  readonly color: ColorRole;
}): ReactNode {
  const { block, x, y, color } = props;
  const { lineHeight } = DIAGRAM_METRICS;
  const first = y - ((block.lines.length - 1) * lineHeight) / 2;
  const lines = block.lines.map((line, i) => ({
    line,
    y: first + i * lineHeight,
  }));
  return lines.map((at) => (
    <text
      key={at.y}
      x={x}
      y={at.y}
      textAnchor="middle"
      dominantBaseline="central"
      style={{ ...TEXT_STYLE, ...fill(color) }}
    >
      {at.line}
    </text>
  ));
}

const SHAPE_STYLE: CSSProperties = {
  ...fill('nodeFill'),
  ...stroke('nodeStroke'),
  strokeWidth: 1.5,
};

/** One node's shape in its box. */
function Shape(props: {
  readonly node: FlowNode;
  readonly box: Box;
}): ReactNode {
  const { x, y, width, height } = props.box;
  switch (props.node.shape) {
    case 'round':
      return (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={height / 2}
          style={SHAPE_STYLE}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={[
            [x + width / 2, y],
            [x + width, y + height / 2],
            [x + width / 2, y + height],
            [x, y + height / 2],
          ]
            .map((point) => point.join(','))
            .join(' ')}
          style={SHAPE_STYLE}
        />
      );
    case 'circle':
      return (
        <ellipse
          cx={x + width / 2}
          cy={y + height / 2}
          rx={width / 2}
          ry={height / 2}
          style={SHAPE_STYLE}
        />
      );
    case 'cylinder': {
      const rx = width / 2;
      const cap = CYLINDER_CAP;
      const arc = `A ${rx} ${cap} 0 0 0`;
      return (
        <>
          <path
            d={`M ${x} ${y + cap} L ${x} ${y + height - cap} ${arc} ${x + width} ${y + height - cap} L ${x + width} ${y + cap} Z`}
            style={SHAPE_STYLE}
          />
          <ellipse
            cx={x + rx}
            cy={y + cap}
            rx={rx}
            ry={cap}
            style={SHAPE_STYLE}
          />
        </>
      );
    }
    default:
      return (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={4}
          style={SHAPE_STYLE}
        />
      );
  }
}

/** The centre of a node's label: below a cylinder's top cap, else the box's centre. */
const labelCentre = (node: FlowNode, box: Box): Point => ({
  x: box.x + box.width / 2,
  y:
    node.shape === 'cylinder'
      ? box.y + (box.height + CYLINDER_CAP) / 2
      : box.y + box.height / 2,
});

const pathOf = (points: readonly Point[]): string =>
  points.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');

/**
 * The SVG of a laid-out Flowchart, in paint order: groups from the outermost, edges, nodes,
 * edge labels. One `svg[role="img"]`, `aria-label` the outline's header,
 * `aria-describedby={outlineId}`.
 */
export function FlowchartPicture(props: {
  readonly model: FlowchartModel;
  readonly sizes: Sizes;
  readonly result: LayoutResult;
  readonly outlineId: string;
}): ReactNode {
  const { model, sizes, result, outlineId } = props;
  const arrow = `${useId()}-arrow`;
  // Each part with its layout key (graph.ts): node i is `n<i>`, edge i `e<i>`, group i `g<i>`.
  const nodes = model.nodes.map((node, i) => ({
    node,
    key: `n${i}`,
    box: result.nodes[`n${i}`],
    size: sizes.nodes[i],
  }));
  const edges = model.edges.map((edge, i) => ({
    edge,
    key: `e${i}`,
    laid: result.edges[`e${i}`],
    size: sizes.edges[i],
  }));
  const groups = model.groups
    .map((group, i) => ({ group, key: `g${i}`, box: result.groups[`g${i}`] }))
    .sort((a, b) => a.group.depth - b.group.depth);
  const byId = new Map(nodes.map((part) => [part.node.id, part]));
  const { groupPadding, lineHeight } = DIAGRAM_METRICS;

  /** The edge's points, its ends moved onto a diamond's or a circle's outline. */
  const route = (edge: FlowEdge, points: readonly Point[]) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const start =
      from?.box === undefined
        ? points
        : endOnShape(points, 'start', from.node.shape, from.box);
    return to?.box === undefined
      ? start
      : endOnShape(start, 'end', to.node.shape, to.box);
  };

  return (
    <svg
      role="img"
      aria-label={outlineHeader(model)}
      aria-describedby={outlineId}
      width={result.width}
      height={result.height}
      viewBox={`0 0 ${result.width} ${result.height}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 10 10"
          refX={10}
          refY={5}
          markerWidth={8}
          markerHeight={8}
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" style={fill('edge')} />
        </marker>
      </defs>
      {groups.map(({ group, key, box }) =>
        box === undefined ? null : (
          <g key={key}>
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={8}
              style={{
                ...fill(GROUP_FILLS[group.depth - 1] ?? 'group4'),
                ...stroke('groupStroke'),
              }}
            />
            <text
              x={box.x + groupPadding}
              y={box.y + groupPadding / 2 + lineHeight / 2}
              dominantBaseline="central"
              style={{ ...TEXT_STYLE, ...fill('groupText') }}
            >
              {group.label}
            </text>
          </g>
        ),
      )}
      {edges.map(({ edge, key, laid }) =>
        laid === undefined || laid.points.length < 2 ? null : (
          <path
            key={key}
            d={pathOf(route(edge, laid.points))}
            fill="none"
            strokeDasharray={edge.line === 'dashed' ? '6 4' : undefined}
            markerEnd={edge.arrow === 'end' ? `url(#${arrow})` : undefined}
            style={{ ...stroke('edge'), strokeWidth: 1.5 }}
          />
        ),
      )}
      {nodes.map(({ node, key, box, size }) => {
        if (box === undefined || size === undefined) return null;
        const centre = labelCentre(node, box);
        return (
          <g key={key}>
            <Shape node={node} box={box} />
            <Label
              block={size.label}
              x={centre.x}
              y={centre.y}
              color="nodeText"
            />
          </g>
        );
      })}
      {edges.map(({ key, laid, size }) => {
        const box = laid?.label;
        if (box === undefined || size === undefined) return null;
        return (
          <g key={key}>
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={3}
              style={fill('labelPlate')}
            />
            <Label
              block={size.label}
              x={box.x + box.width / 2}
              y={box.y + box.height / 2}
              color="edgeText"
            />
          </g>
        );
      })}
    </svg>
  );
}

const BUTTON =
  'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground';

/**
 * The area, its height and the viewport, with the toolbar when `interactive`; `children` is
 * the SVG. Height: `writtenHeight` clamped to 160–1200 px, else the fitted content plus
 * margin clamped to 160–560 px (computed when mounted, not on resize). When `interactive`:
 * focusable, labelled `areaLabel`, with the toolbar ("Zoom out", percent, "Zoom in", "Fit to
 * view") and the gestures; otherwise none of these.
 */
export function DiagramFrame(props: {
  readonly content: { readonly width: number; readonly height: number };
  readonly writtenHeight?: number;
  readonly interactive: boolean;
  /** The area's label when interactive: `<Type>, pan and zoom`. */
  readonly areaLabel: string;
  readonly children: ReactNode;
}): ReactNode {
  const { content, writtenHeight, interactive, areaLabel, children } = props;
  const area = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState(() =>
    areaHeight(writtenHeight, content, 0),
  );
  useLayoutEffect(() => {
    setHeight(
      areaHeight(writtenHeight, content, area.current?.clientWidth ?? 0),
    );
  }, [writtenHeight, content]);
  const view = useDiagramViewport(area, content, interactive);

  return (
    <div className="openui-flowchart relative w-full">
      <div
        ref={area}
        className="w-full overflow-hidden rounded-lg border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{
          height: `${height}px`,
          position: 'relative',
          touchAction: interactive ? 'none' : undefined,
        }}
        {...(interactive
          ? {
              tabIndex: 0,
              role: 'group',
              'aria-label': areaLabel,
            }
          : {})}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transformOrigin: '0 0',
            transform: viewportTransform(view.viewport),
          }}
        >
          {children}
        </div>
      </div>
      {interactive ? (
        <div className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-border bg-background p-0.5 text-xs shadow-sm">
          <button
            type="button"
            className={BUTTON}
            aria-label="Zoom out"
            title="Zoom out"
            onClick={view.zoomOut}
          >
            <ZoomOut className="size-4" aria-hidden />
          </button>
          <span className="min-w-10 text-center tabular-nums">
            {view.percent}
          </span>
          <button
            type="button"
            className={BUTTON}
            aria-label="Zoom in"
            title="Zoom in"
            onClick={view.zoomIn}
          >
            <ZoomIn className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={BUTTON}
            aria-label="Fit to view"
            title="Fit to view"
            onClick={view.fit}
          >
            <Maximize className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The drawn Flowchart: `DiagramFrame` labelled "Flowchart, pan and zoom" around
 * `FlowchartPicture`, its height from `model.height`. `model`, `sizes` and `result` must come
 * from one model (same indices and keys).
 */
export function DiagramCanvas(props: {
  readonly model: FlowchartModel;
  readonly sizes: Sizes;
  readonly result: LayoutResult;
  readonly interactive: boolean;
  /** The outline's id, for aria-describedby. */
  readonly outlineId: string;
}): ReactNode {
  const { model, sizes, result, interactive, outlineId } = props;
  return (
    <DiagramFrame
      content={result}
      writtenHeight={model.height}
      interactive={interactive}
      areaLabel="Flowchart, pan and zoom"
    >
      <FlowchartPicture
        model={model}
        sizes={sizes}
        result={result}
        outlineId={outlineId}
      />
    </DiagramFrame>
  );
}
