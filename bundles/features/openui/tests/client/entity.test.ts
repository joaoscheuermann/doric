// FT26 (openui-diagrams-phase2.md F16, F17, F18, F20): an EntityDiagram drawn
// by the chunk's `ConversationFence` with a fake `layout`. Under `er`, keys,
// crow's-foot markers and the relation's label plate; under `class`, the
// layout graph of an inherits relation runs from the parent, with its counts
// as end labels swapped with the ends, and each kind draws F20's line and
// markers.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { act } from 'react';

import { cssColor, DIAGRAM_COLORS } from '../../src/client/diagram/colors.js';
import type {
  Box,
  LayoutGraph,
  LayoutResult,
  Point,
} from '../../src/client/diagram/layout-types.js';
import { DIAGRAM_METRICS } from '../../src/client/diagram/measure.js';
import { closeWindow, settle } from './support/dom.js';
import {
  chatFence,
  fenceServices,
  mountFence,
  revisionOf,
} from './support/fence.js';

after(closeWindow);

const program = (
  notation: 'er' | 'class',
  entities: string,
  relations: string,
) =>
  [
    'root = Stack([model])',
    `model = EntityDiagram(entities, relations, "${notation}")`,
    `entities = [${entities}]`,
    `relations = [${relations}]`,
    '',
  ].join('\n');

const ER = program(
  'er',
  'Entity("user", "users", [Field("id", "uuid", "pk"), Field("email", "text", "unique")]), Entity("order", "orders", [Field("id", "uuid", "pk"), Field("user_id", "uuid", "fk")])',
  'Relation("user", "order", "association", "places", "1", "*")',
);

const CLASS_ENTITIES =
  'Entity("dog", "Dog", [Field("name", "string")], ["bark(): void"]), Entity("animal", "Animal", [Field("age", "int")])';

const CLASS = program(
  'class',
  CLASS_ENTITIES,
  'Relation("dog", "animal", "inherits", "", "*", "1")',
);

const text = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The items of the list labelled `label` (by aria-label or aria-labelledby), own text only. */
const listItems = (container: Element, label: string): string[] => {
  const list = [...container.querySelectorAll('ul')].find((candidate) => {
    if (candidate.getAttribute('aria-label') === label) return true;
    const by = candidate.getAttribute('aria-labelledby');
    return (
      by !== null &&
      by
        .split(/\s+/)
        .map((id) => text(document.getElementById(id)))
        .join(' ') === label
    );
  });
  assert.ok(list !== undefined, `a list labelled ${label}`);
  return [...list.children].map((item) =>
    [...item.childNodes]
      .filter((child) => child.nodeName.toLowerCase() !== 'ul')
      .map((child) => child.textContent ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim(),
  );
};

const picture = (container: Element) =>
  container.querySelector('svg[role="img"]');

/** Nodes side by side, 300 px apart; each edge a straight line between the boxes' facing sides. */
const fakeLayout = async (graph: LayoutGraph): Promise<LayoutResult> => {
  const nodes: Record<string, Box> = {};
  graph.nodes.forEach((node, i) => {
    nodes[node.key] = {
      x: 40 + i * 300,
      y: 40,
      width: node.width,
      height: node.height,
    };
  });
  const edges: Record<
    string,
    { points: Point[]; label?: Box; tailLabel?: Box; headLabel?: Box }
  > = {};
  for (const edge of graph.edges) {
    const from = nodes[edge.from] as Box;
    const to = nodes[edge.to] as Box;
    const y = 60;
    const start =
      from.x < to.x ? { x: from.x + from.width, y } : { x: from.x, y };
    const end = from.x < to.x ? { x: to.x, y } : { x: to.x + to.width, y };
    const mid = (start.x + end.x) / 2;
    edges[edge.key] = {
      points: [start, end],
      ...(edge.label === undefined
        ? {}
        : { label: { x: mid - edge.label.width / 2, y: 70, ...edge.label } }),
      ...(edge.tailLabel === undefined
        ? {}
        : { tailLabel: { x: start.x, y: 30, ...edge.tailLabel } }),
      ...(edge.headLabel === undefined
        ? {}
        : { headLabel: { x: end.x, y: 30, ...edge.headLabel } }),
    };
  }
  return {
    width: 80 + graph.nodes.length * 300,
    height: 400,
    nodes,
    groups: {},
    edges,
  };
};

const mount = async (body: string) => {
  const graphs: LayoutGraph[] = [];
  const results: LayoutResult[] = [];
  const fence = chatFence(body);
  const { services } = fenceServices();
  const mounted = await mountFence({
    view: { fence, origin: 'user', fences: [fence] },
    revision: revisionOf(fence),
    services,
    layout: async (graph) => {
      graphs.push(graph);
      const result = await fakeLayout(graph);
      results.push(result);
      return result;
    },
  });
  await act(async () => {
    await settle(20);
  });
  const svg = picture(mounted.container);
  assert.ok(svg !== null, 'an svg[role="img"]');
  return { mounted, svg, graphs, results };
};

const markers = (svg: Element, kind?: string): Element[] => [
  ...svg.querySelectorAll(
    kind === undefined ? '[data-marker]' : `[data-marker="${kind}"]`,
  ),
];

const NUMBER = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;

/**
 * Where a marker is drawn: the translation of its first `translate(…)` when
 * it is placed by a transform, else the mean of the coordinates its shapes give.
 */
const markerCentre = (marker: Element): Point => {
  for (const at of [marker, ...marker.querySelectorAll('*')]) {
    const translate = /translate\(\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)/.exec(
      at.getAttribute('transform') ?? '',
    );
    if (translate !== null) {
      return { x: Number(translate[1]), y: Number(translate[2]) };
    }
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const shape of [marker, ...marker.querySelectorAll('*')]) {
    for (const [x, y] of [
      ['x', 'y'],
      ['cx', 'cy'],
      ['x1', 'y1'],
      ['x2', 'y2'],
    ] as const) {
      const px = shape.getAttribute(x);
      const py = shape.getAttribute(y);
      if (px !== null && py !== null) {
        xs.push(Number(px));
        ys.push(Number(py));
      }
    }
    for (const list of [
      shape.getAttribute('points'),
      shape.getAttribute('d'),
    ]) {
      const numbers = (list ?? '').match(NUMBER)?.map(Number) ?? [];
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        xs.push(numbers[i] as number);
        ys.push(numbers[i + 1] as number);
      }
    }
  }
  assert.ok(xs.length > 0, 'the marker has coordinates');
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  return { x: mean(xs), y: mean(ys) };
};

const centre = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** The key of the node box nearest `point`. */
const nearest = (result: LayoutResult, point: Point): string =>
  Object.entries(result.nodes)
    .map(([key, box]) => ({
      key,
      distance: Math.hypot(centre(box).x - point.x, centre(box).y - point.y),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.key ?? '';

const fillOf = (element: Element): string =>
  element.getAttribute('fill') ??
  (element as SVGElement & ElementCSSInlineStyle).style.getPropertyValue(
    'fill',
  );

/** The fills of a marker's shapes. */
const fills = (marker: Element): string[] =>
  [marker, ...marker.querySelectorAll('*')]
    .map(fillOf)
    .filter((fill) => fill !== '');

const isDashed = (element: Element) => {
  const dashes =
    element.getAttribute('stroke-dasharray') ??
    (element as SVGElement & ElementCSSInlineStyle).style.getPropertyValue(
      'stroke-dasharray',
    );
  return dashes !== null && dashes !== '' && dashes !== 'none';
};

/** The relation lines: paths and polylines outside every marker. */
const lines = (svg: Element): Element[] =>
  [...svg.querySelectorAll('path, polyline')].filter(
    (line) => line.closest('[data-marker]') === null,
  );

const NODE_FILL = cssColor(DIAGRAM_COLORS.nodeFill);

test("FT26: under er, names, the key column, a one-bar marker at users, a crow's foot at orders and the label plate", async () => {
  const { mounted, svg, results } = await mount(ER);
  const { container } = mounted;

  assert.equal(
    svg.getAttribute('aria-label'),
    'ER diagram: 2 entities, 1 relation',
  );
  assert.ok(
    container.querySelector('[aria-label="ER diagram, pan and zoom"]') !== null,
    'the area is labelled',
  );
  for (const label of ['users', 'orders', 'PK', 'places']) {
    assert.ok(text(svg).includes(label), label);
  }

  const result = results.at(-1) as LayoutResult;
  const one = markers(svg, 'one');
  const many = markers(svg, 'many');
  assert.equal(one.length, 1, 'one one-bar marker');
  assert.equal(many.length, 1, "one circle-and-crow's-foot marker");
  assert.equal(markers(svg).length, 2, 'no other marker');
  assert.equal(
    nearest(result, markerCentre(one[0] as Element)),
    'n0',
    'at users',
  );
  assert.equal(
    nearest(result, markerCentre(many[0] as Element)),
    'n1',
    'at orders',
  );

  assert.deepEqual(listItems(container, 'Relations'), [
    'users → orders 1 to *: places',
  ]);
  await mounted.unmount();
});

test('FT26: under class, inherits draws from the parent, with a hollow triangle at the parent', async () => {
  const { mounted, svg, graphs, results } = await mount(CLASS);
  const { container } = mounted;

  const graph = graphs.at(-1);
  assert.ok(graph !== undefined, 'the layout was called');
  assert.equal(graph.markerSpacing, true);
  assert.equal(graph.transposeRight, true);
  // dog is n0, animal n1: the edge runs from the parent to the child.
  assert.equal(graph.edges[0]?.from, 'n1');
  assert.equal(graph.edges[0]?.to, 'n0');

  const triangles = markers(svg, 'triangle');
  assert.equal(triangles.length, 1, 'one triangle');
  assert.equal(markers(svg).length, 1, 'no other marker');
  const result = results.at(-1) as LayoutResult;
  assert.equal(
    nearest(result, markerCentre(triangles[0] as Element)),
    'n1',
    'at Animal',
  );
  assert.ok(fills(triangles[0] as Element).includes(NODE_FILL), 'hollow');

  for (const label of ['Dog', 'Animal', 'bark(): void', '*', '1']) {
    assert.ok(text(svg).includes(label), label);
  }
  assert.deepEqual(listItems(container, 'Relations'), [
    'Dog → Animal (inherits) * to 1',
  ]);
  assert.ok(
    container.querySelector('[aria-label="Class diagram, pan and zoom"]') !==
      null,
    'the area is labelled',
  );
  await mounted.unmount();
});

test('FT26: under class, a reversed relation swaps its end labels with its ends', async () => {
  // fromCount "1..*" (4 characters) and toCount "1" (1 character) tell the two apart.
  const { mounted, graphs } = await mount(
    program(
      'class',
      CLASS_ENTITIES,
      'Relation("dog", "animal", "inherits", "", "1..*", "1")',
    ),
  );
  const edge = (graphs.at(-1) as LayoutGraph).edges[0];
  const { estimate } = DIAGRAM_METRICS;

  assert.deepEqual(edge?.tailLabel, { width: estimate * 1 + 8, height: 26 });
  assert.deepEqual(edge?.headLabel, { width: estimate * 4 + 8, height: 26 });
  await mounted.unmount();
});

/** F20's class table: dashed line, then the marker at `from` and at `to`. */
const KINDS = [
  { kind: 'association', dashed: false, from: undefined, to: undefined },
  { kind: 'inherits', dashed: false, from: undefined, to: 'triangle' },
  { kind: 'implements', dashed: true, from: undefined, to: 'triangle' },
  { kind: 'composition', dashed: false, from: 'diamond', to: undefined },
  { kind: 'aggregation', dashed: false, from: 'diamond', to: undefined },
  { kind: 'dependency', dashed: true, from: undefined, to: 'arrow' },
] as const;

for (const { kind, dashed, from, to } of KINDS) {
  test(`FT26: under class, ${kind} draws a ${dashed ? 'dashed' : 'solid'} line and its markers`, async () => {
    const { mounted, svg, results } = await mount(
      program('class', CLASS_ENTITIES, `Relation("dog", "animal", "${kind}")`),
    );
    const result = results.at(-1) as LayoutResult;

    const drawn = lines(svg);
    assert.equal(drawn.length, 1, 'one relation line');
    assert.equal(isDashed(drawn[0] as Element), dashed, 'dashed');

    const all = markers(svg);
    assert.equal(all.length, [from, to].filter(Boolean).length, 'markers');
    for (const [end, marker, at] of [
      ['from', from, 'n0'],
      ['to', to, 'n1'],
    ] as const) {
      if (marker === undefined) continue;
      const found = all.find(
        (candidate) => nearest(result, markerCentre(candidate)) === at,
      );
      assert.ok(found !== undefined, `a marker at ${end}`);
      assert.equal(found.getAttribute('data-marker'), marker, `${end} marker`);
    }
    if (kind === 'composition') {
      assert.equal(
        fills(all[0] as Element).includes(NODE_FILL),
        false,
        'filled',
      );
    }
    if (kind === 'aggregation') {
      assert.ok(fills(all[0] as Element).includes(NODE_FILL), 'hollow');
    }
    await mounted.unmount();
  });
}
