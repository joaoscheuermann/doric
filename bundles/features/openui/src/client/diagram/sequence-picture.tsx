// The drawn sequence diagram (openui-diagrams-phase2.md F20): fragments,
// dashed lifelines, headers, notes, messages and their label plates, in that
// paint order.

import type { ReactNode } from 'react';

import { fill, Label, stroke } from './canvas.js';
import type { Point } from './layout-types.js';
import { DIAGRAM_METRICS } from './measure.js';
import { sequenceOutline } from './outline.js';
import type { SequenceLayout, SequenceStepBox } from './sequence-layout.js';
import type { SequenceModel } from './sequence-model.js';

const DASHES = '6 4';
const LINE = { ...stroke('edge'), strokeWidth: 1.5 };
/** An arrowhead's length and half width, in px. */
const HEAD = { length: 10, half: 4 };

type MessageBox = Extract<SequenceStepBox, { type: 'message' }>;
type FragmentBox = Extract<SequenceStepBox, { type: 'fragment' }>;

const pointsOf = (points: readonly Point[]): string =>
  points.map(({ x, y }) => `${x},${y}`).join(' ');

/** A message's line and its arrowhead at the last point: filled for `call`, open otherwise. */
function Arrow(props: { readonly box: MessageBox }): ReactNode {
  const { points, kind } = props.box;
  const end = points.at(-1);
  const before = points.at(-2);
  if (end === undefined || before === undefined) return null;
  const run = Math.hypot(end.x - before.x, end.y - before.y) || 1;
  const dx = (end.x - before.x) / run;
  const dy = (end.y - before.y) / run;
  const base = { x: end.x - dx * HEAD.length, y: end.y - dy * HEAD.length };
  const head = pointsOf([
    { x: base.x - dy * HEAD.half, y: base.y + dx * HEAD.half },
    end,
    { x: base.x + dy * HEAD.half, y: base.y - dx * HEAD.half },
  ]);
  const dashes = kind === 'reply' ? DASHES : undefined;
  return (
    <g>
      {points.length === 2 ? (
        <line
          x1={before.x}
          y1={before.y}
          x2={end.x}
          y2={end.y}
          strokeDasharray={dashes}
          style={LINE}
        />
      ) : (
        <polyline
          points={pointsOf(points)}
          fill="none"
          strokeDasharray={dashes}
          style={LINE}
        />
      )}
      {kind === 'call' ? (
        <polygon points={head} style={{ ...fill('edge'), ...LINE }} />
      ) : (
        <polyline points={head} fill="none" style={LINE} />
      )}
    </g>
  );
}

/** A fragment's rectangle, kind tab, section labels and dashed separators. */
function Fragment(props: { readonly box: FragmentBox }): ReactNode {
  const { box, tab, kind, sections } = props.box;
  // The label lines are as tall as the tab, their text padded as the kind's.
  const padding = (tab.height - DIAGRAM_METRICS.lineHeight) / 2;
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        fill="none"
        style={{ ...stroke('groupStroke'), strokeWidth: 1.5 }}
      />
      <rect
        x={tab.x}
        y={tab.y}
        width={tab.width}
        height={tab.height}
        style={{ ...fill('group1'), ...stroke('groupStroke'), strokeWidth: 1 }}
      />
      <Label
        block={{
          lines: [kind],
          width: tab.width - 2 * padding,
          height: DIAGRAM_METRICS.lineHeight,
        }}
        x={tab.x + tab.width / 2}
        y={tab.y + tab.height / 2}
        color="groupText"
      />
      {sections.map((section, i) => (
        <g
          // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
          key={`c${i}`}
        >
          {i === 0 ? null : (
            <line
              x1={box.x}
              y1={section.y}
              x2={box.x + box.width}
              y2={section.y}
              strokeDasharray={DASHES}
              style={{ ...stroke('groupStroke'), strokeWidth: 1 }}
            />
          )}
          <Label
            block={section.label}
            x={box.x + 2 * padding + section.label.width / 2}
            y={section.y + tab.height / 2}
            color="nodeText"
          />
        </g>
      ))}
    </g>
  );
}

/**
 * One `svg[role="img"]`, `layout.width` × `layout.height`, `aria-label`
 * `sequenceOutline(model).header`, `aria-describedby={outlineId}`. Paint order: fragments from
 * the outermost (unfilled rectangle, kind tab, `[label]` per section, dashed separators after the
 * first), lifelines (dashed), headers (`box`), notes, messages (`call` solid + filled arrowhead,
 * `reply` dashed + open arrowhead, `async` solid + open arrowhead), labels. Colors: phase 1's
 * roles only. `model` and `layout` must come from one model.
 */
export function SequencePicture(props: {
  readonly model: SequenceModel;
  readonly layout: SequenceLayout;
  readonly outlineId: string;
}): ReactNode {
  const { model, layout, outlineId } = props;
  const { steps, columns } = layout;
  return (
    <svg
      role="img"
      aria-label={sequenceOutline(model).header}
      aria-describedby={outlineId}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {steps.map((box, i) =>
        box.type === 'fragment' ? (
          <Fragment
            // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
            key={`s${i}`}
            box={box}
          />
        ) : null,
      )}
      {columns.map((column, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
          key={`l${i}`}
          x1={column.x}
          y1={layout.top}
          x2={column.x}
          y2={layout.bottom}
          strokeDasharray={DASHES}
          style={{ ...stroke('edge'), strokeWidth: 1 }}
        />
      ))}
      {columns.map(({ header, label }, i) => (
        <g
          // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
          key={`h${i}`}
        >
          <rect
            x={header.x}
            y={header.y}
            width={header.width}
            height={header.height}
            rx={4}
            style={{
              ...fill('nodeFill'),
              ...stroke('nodeStroke'),
              strokeWidth: 1.5,
            }}
          />
          <Label
            block={label}
            x={header.x + header.width / 2}
            y={header.y + header.height / 2}
            color="nodeText"
          />
        </g>
      ))}
      {steps.map((step, i) =>
        step.type === 'note' ? (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
            key={`s${i}`}
          >
            <rect
              x={step.box.x}
              y={step.box.y}
              width={step.box.width}
              height={step.box.height}
              style={{
                ...fill('group2'),
                ...stroke('groupStroke'),
                strokeWidth: 1,
              }}
            />
            <Label
              block={step.text}
              x={step.box.x + step.box.width / 2}
              y={step.box.y + step.box.height / 2}
              color="groupText"
            />
          </g>
        ) : null,
      )}
      {steps.map((step, i) =>
        step.type === 'message' ? (
          <Arrow
            // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
            key={`s${i}`}
            box={step}
          />
        ) : null,
      )}
      {steps.map((step, i) =>
        step.type === 'message' ? (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: the layout's order is each part's identity
            key={`p${i}`}
          >
            <rect
              x={step.label.x}
              y={step.label.y}
              width={step.label.width}
              height={step.label.height}
              rx={3}
              style={fill('labelPlate')}
            />
            <Label
              block={step.text}
              x={step.label.x + step.label.width / 2}
              y={step.label.y + step.label.height / 2}
              color="edgeText"
            />
          </g>
        ) : null,
      )}
    </svg>
  );
}
