// The drawn ER or class diagram (openui-diagrams-phase2.md F20): entities as
// boxes with a header band and rows, relations as paths through ELK's points
// with their line-end markers, labels and, under `class`, counts.

import type { ReactNode } from 'react';

import { fill, Label, stroke, TEXT_STYLE } from './canvas.js';
import type { ColorRole } from './colors.js';
import type { COUNTS } from './definitions.js';
import type { EntityField, EntityModel } from './entity-model.js';
import { isReversed } from './graph.js';
import type { Box, LayoutResult, Point } from './layout-types.js';
import {
  DIAGRAM_METRICS,
  type EntitySizes,
  type TextBlock,
} from './measure.js';
import { entityOutline } from './outline.js';

type Marker =
  | 'one'
  | 'zero-one'
  | 'many'
  | 'one-many'
  | 'triangle'
  | 'diamond'
  | 'arrow';

/** The crow's-foot marker of each count under `er`. */
const COUNT_MARKERS: Readonly<Record<(typeof COUNTS)[number], Marker>> = {
  '1': 'one',
  '0..1': 'zero-one',
  '*': 'many',
  '1..*': 'one-many',
};

/** A field's key as the key column writes it. */
const KEY_TEXT: Readonly<Record<NonNullable<EntityField['key']>, string>> = {
  pk: 'PK',
  fk: 'FK',
  'pk-fk': 'PK FK',
  unique: 'UQ',
};

const LINE = { ...stroke('edge'), strokeWidth: 1.5 } as const;

const pathOf = (points: readonly Point[]): string =>
  points.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');

/**
 * A marker's shapes in its own frame: the line's end at the origin, the line running
 * along +x. Each fits F20's box (length × width): one 8×12, zero-one 14×12, many 18×12,
 * one-many 12×12, triangle 12×12, diamond 16×10, arrow 10×10.
 */
function MarkerShapes(props: {
  readonly kind: Marker;
  readonly solid: boolean;
}): ReactNode {
  const hollow = { ...fill('nodeFill'), ...LINE };
  const bar = (x: number) => <line x1={x} y1={-6} x2={x} y2={6} style={LINE} />;
  const foot = (tip: number) => (
    <path d={`M 0 -6 L ${tip} 0 L 0 6`} fill="none" style={LINE} />
  );
  const circle = (cx: number) => <circle cx={cx} cy={0} r={4} style={hollow} />;
  switch (props.kind) {
    case 'one':
      return bar(6);
    case 'zero-one':
      return (
        <>
          {bar(3)}
          {circle(9)}
        </>
      );
    case 'many':
      return (
        <>
          {foot(10)}
          {circle(14)}
        </>
      );
    case 'one-many':
      return (
        <>
          {foot(8)}
          {bar(10)}
        </>
      );
    case 'triangle':
      return <polygon points="0,0 12,-6 12,6" style={hollow} />;
    case 'diamond':
      return (
        <polygon
          points="0,0 8,-5 16,0 8,5"
          style={{ ...LINE, ...fill(props.solid ? 'edge' : 'nodeFill') }}
        />
      );
    case 'arrow':
      return <polyline points="10,-5 0,0 10,5" fill="none" style={LINE} />;
  }
}

/** One marker at `end`, turned toward `next` (the line's neighbouring point). */
function EndMarker(props: {
  readonly kind: Marker;
  readonly end: Point;
  readonly next: Point;
  readonly solid?: boolean;
}): ReactNode {
  const { kind, end, next } = props;
  const angle = (Math.atan2(next.y - end.y, next.x - end.x) * 180) / Math.PI;
  return (
    <g
      data-marker={kind}
      transform={`translate(${end.x} ${end.y}) rotate(${angle})`}
    >
      <MarkerShapes kind={kind} solid={props.solid === true} />
    </g>
  );
}

/** A plate at `box` with `block` centred on it. */
function Plate(props: {
  readonly box: Box;
  readonly block: TextBlock;
}): ReactNode {
  const { box } = props;
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={3}
        style={fill('labelPlate')}
      />
      <Label
        block={props.block}
        x={box.x + box.width / 2}
        y={box.y + box.height / 2}
        color="edgeText"
      />
    </g>
  );
}

/** One row of text, left-aligned at `x`, centred on `y`. */
function Row(props: {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly color?: ColorRole;
}): ReactNode {
  return (
    <text
      x={props.x}
      y={props.y}
      dominantBaseline="central"
      style={{ ...TEXT_STYLE, ...fill(props.color ?? 'nodeText') }}
    >
      {props.text}
    </text>
  );
}

/** The markers of a relation's two ends: `[at from, at to]`. */
const markersOf = (
  model: EntityModel,
  relation: EntityModel['relations'][number],
): readonly [Marker | undefined, Marker | undefined] => {
  if (model.notation === 'er') {
    return [
      relation.fromCount === undefined
        ? undefined
        : COUNT_MARKERS[relation.fromCount],
      relation.toCount === undefined
        ? undefined
        : COUNT_MARKERS[relation.toCount],
    ];
  }
  switch (relation.kind) {
    case 'inherits':
    case 'implements':
      return [undefined, 'triangle'];
    case 'composition':
    case 'aggregation':
      return ['diamond', undefined];
    case 'dependency':
      return [undefined, 'arrow'];
    default:
      return [undefined, undefined];
  }
};

/**
 * One `svg[role="img"]`, `result.width` × `result.height`, `aria-label`
 * `entityOutline(model).header`, `aria-describedby={outlineId}`. Each entity a rectangle with a
 * header band (name), field rows (under `er` a key column `PK`/`FK`/`PK FK`/`UQ`), and under
 * `class` a separator and method rows. Each relation a path through `result.edges['e<i>'].points`
 * (reversed for a reversed relation), dashed for `implements` and `dependency`; its label on a
 * plate at its label box; under `class`, counts as text in the end-label boxes.
 * Every line-end marker is one `<g data-marker="…">` at its end of the line, one of:
 * `one` (`1`), `zero-one` (`0..1`), `many` (`*`), `one-many` (`1..*`) — under `er`, at each end
 * with a count; `triangle` (hollow, at `to`: `inherits`, `implements`), `diamond` (at `from`:
 * filled for `composition`, hollow — `nodeFill` — for `aggregation`), `arrow` (open, at `to`:
 * `dependency`) — under `class`. No other element carries `data-marker`. Each marker fits F20's
 * box along its line (length × width: one 8×12, zero-one 14×12, many 18×12, one-many 12×12,
 * triangle 12×12, diamond 16×10, arrow 10×10). `sizes` and `result` must come from this model.
 */
export function EntityPicture(props: {
  readonly model: EntityModel;
  readonly sizes: EntitySizes;
  readonly result: LayoutResult;
  readonly outlineId: string;
}): ReactNode {
  const { model, sizes, result, outlineId } = props;
  const { nodePadding, lineHeight } = DIAGRAM_METRICS;
  const band = lineHeight + 2 * nodePadding;
  // Entity i is `n<i>` and relation i `e<i>` (graph.ts).
  const relations = model.relations.flatMap((relation, i) => {
    const laid = result.edges[`e${i}`];
    if (laid === undefined || laid.points.length < 2) return [];
    const reversed = isReversed(model, relation);
    const points = reversed ? [...laid.points].reverse() : laid.points;
    const [first, second] = points;
    const last = points.at(-1);
    const beforeLast = points.at(-2);
    if (
      first === undefined ||
      second === undefined ||
      last === undefined ||
      beforeLast === undefined
    ) {
      return [];
    }
    const ends = { first, second, last, beforeLast };
    return [{ relation, i, laid, points, ends, reversed }];
  });

  return (
    <svg
      role="img"
      aria-label={entityOutline(model).header}
      aria-describedby={outlineId}
      width={result.width}
      height={result.height}
      viewBox={`0 0 ${result.width} ${result.height}`}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {relations.map(({ relation, i, points }) => (
        <path
          key={`e${i}`}
          d={pathOf(points)}
          fill="none"
          strokeDasharray={
            relation.kind === 'implements' || relation.kind === 'dependency'
              ? '6 4'
              : undefined
          }
          style={LINE}
        />
      ))}
      {model.entities.map((entity, i) => {
        const key = `n${i}`;
        const box = result.nodes[key];
        const size = sizes.entities[i];
        if (box === undefined || size === undefined) return null;
        const left = box.x + nodePadding;
        const rowY = (row: number) =>
          box.y + band + row * lineHeight + lineHeight / 2;
        const fields = entity.fields.length;
        const methodsTop = rowY(fields) - lineHeight / 2;
        return (
          <g key={key}>
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={4}
              style={{
                ...fill('nodeFill'),
                ...stroke('nodeStroke'),
                strokeWidth: 1.5,
              }}
            />
            <rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={band}
              rx={4}
              style={{
                ...fill('group1'),
                ...stroke('nodeStroke'),
                strokeWidth: 1.5,
              }}
            />
            <Label
              block={size.name}
              x={box.x + box.width / 2}
              y={box.y + band / 2}
              color="groupText"
            />
            {entity.fields.map((field, row) => (
              <g
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's index is its identity
                key={`f${row}`}
              >
                {model.notation === 'er' && field.key !== undefined ? (
                  <Row x={left} y={rowY(row)} text={KEY_TEXT[field.key]} />
                ) : null}
                <Row
                  x={left + sizes.keyColumn}
                  y={rowY(row)}
                  text={size.rows[row] ?? field.name}
                />
              </g>
            ))}
            {entity.methods.length === 0 ? null : (
              <line
                x1={box.x}
                y1={methodsTop + nodePadding / 2}
                x2={box.x + box.width}
                y2={methodsTop + nodePadding / 2}
                style={{ ...stroke('nodeStroke'), strokeWidth: 1 }}
              />
            )}
            {entity.methods.map((method, row) => (
              <Row
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's index is its identity
                key={`m${row}`}
                x={left}
                y={rowY(fields + row) + nodePadding}
                text={method}
              />
            ))}
          </g>
        );
      })}
      {relations.map(({ relation, i, ends }) => {
        const [atFrom, atTo] = markersOf(model, relation);
        const solid = relation.kind === 'composition';
        return (
          <g key={`m${i}`}>
            {atFrom === undefined ? null : (
              <EndMarker
                kind={atFrom}
                end={ends.first}
                next={ends.second}
                solid={solid}
              />
            )}
            {atTo === undefined ? null : (
              <EndMarker
                kind={atTo}
                end={ends.last}
                next={ends.beforeLast}
                solid={solid}
              />
            )}
          </g>
        );
      })}
      {relations.map(({ relation, i, laid, reversed }) => {
        const label = sizes.labels[i];
        // The layout's tail is the line's first point: `to` for a reversed relation.
        const tail = reversed ? relation.toCount : relation.fromCount;
        const head = reversed ? relation.fromCount : relation.toCount;
        return (
          <g key={`l${i}`}>
            {laid.label === undefined || label === undefined ? null : (
              <Plate box={laid.label} block={label} />
            )}
            {[
              { box: laid.tailLabel, count: tail },
              { box: laid.headLabel, count: head },
            ].map(({ box, count }, end) =>
              box === undefined || count === undefined ? null : (
                <Plate
                  // biome-ignore lint/suspicious/noArrayIndexKey: 0 is the tail plate, 1 the head
                  key={end}
                  box={box}
                  block={{
                    lines: [count],
                    width: box.width,
                    height: lineHeight,
                  }}
                />
              ),
            )}
          </g>
        );
      })}
    </svg>
  );
}
