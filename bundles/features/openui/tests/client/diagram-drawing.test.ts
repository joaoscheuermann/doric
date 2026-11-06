// FT17 (openui-diagrams.md F5, F7): measuring, sizing and drawing a laid-out
// model. Labels wrap on spaces and inside a word wider than a line; each
// shape's box holds its padded label; edges end on a diamond's or a circle's
// outline; the drawing marks dashed edges and arrowheads; and the area's
// height follows F7. Drawn with a fixed `LayoutResult`, no ELK.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { DiagramCanvas } from '../../src/client/diagram/canvas.js';
import { cssColor, DIAGRAM_COLORS } from '../../src/client/diagram/colors.js';
import {
  type EntityModel,
  readEntities,
} from '../../src/client/diagram/entity-model.js';
import { EntityPicture } from '../../src/client/diagram/entity-picture.js';
import { endOnShape } from '../../src/client/diagram/geometry.js';
import type {
  Box,
  LayoutResult,
  Point,
} from '../../src/client/diagram/layout-types.js';
import {
  DIAGRAM_METRICS,
  type Measure,
  sizeEntities,
  sizeMindMap,
  sizeModel,
  wrapLabel,
} from '../../src/client/diagram/measure.js';
import { readMindMap } from '../../src/client/diagram/mindmap-model.js';
import {
  type FlowchartModel,
  readFlowchart,
} from '../../src/client/diagram/model.js';
import { closeWindow, settle } from './support/dom.js';

after(closeWindow);

/** A fixed-width font: 10 px per character. */
const measure: Measure = (text) => [...text].length * 10;

const element = (typeName: string, props: Record<string, unknown>) => ({
  type: 'element',
  typeName,
  props,
});

const modelOf = (props: Record<string, unknown>): FlowchartModel =>
  readFlowchart(props);

const close = (a: number, b: number, epsilon = 1e-6) =>
  Math.abs(a - b) <= epsilon;

// Wrapping (F5).

test('a label wraps on spaces, each line within the width', () => {
  const block = wrapLabel('alpha beta gamma', 110, measure);

  assert.deepEqual(block.lines, ['alpha beta', 'gamma']);
  assert.equal(block.width, 100);
  assert.equal(block.height, 2 * DIAGRAM_METRICS.lineHeight);
});

test('a word wider than a line breaks inside the word', () => {
  const word = 'abcdefghijklmnop';
  const block = wrapLabel(word, 50, measure);

  assert.ok(block.lines.length >= 4, block.lines.join('|'));
  assert.equal(block.lines.join(''), word);
  for (const line of block.lines) assert.ok(measure(line) <= 50, line);
  assert.equal(block.height, block.lines.length * DIAGRAM_METRICS.lineHeight);
});

test('a label that fits stays on one line, and an empty label has no lines', () => {
  assert.deepEqual(wrapLabel('API', 200, measure).lines, ['API']);
  assert.deepEqual(wrapLabel('', 200, measure).lines, []);
});

// Sizing (F5).

const SHAPES = ['box', 'round', 'diamond', 'circle', 'cylinder'] as const;

test('a label that fits on one line in a box takes at least two in a diamond', () => {
  assert.ok(DIAGRAM_METRICS.maxWidth.diamond < DIAGRAM_METRICS.maxWidth.box);
  // Two-letter words, as many as fit the box's width.
  const words: string[] = [];
  while (measure([...words, 'ab'].join(' ')) <= DIAGRAM_METRICS.maxWidth.box) {
    words.push('ab');
  }
  const label = words.join(' ');
  assert.ok(
    measure(label) > DIAGRAM_METRICS.maxWidth.diamond,
    'the label is wider than a diamond line',
  );

  const sizes = sizeModel(
    modelOf({
      nodes: [
        element('Node', { id: 'a', label, shape: 'box' }),
        element('Node', { id: 'b', label, shape: 'diamond' }),
      ],
    }),
    measure,
  );

  assert.equal(sizes.nodes[0]?.label.lines.length, 1);
  assert.ok((sizes.nodes[1]?.label.lines.length ?? 0) >= 2);
});

test("each shape's box holds its padded label; a diamond and a circle are the smallest that do", () => {
  const label = 'Orders database replica';
  const model = modelOf({
    nodes: SHAPES.map((shape) => element('Node', { id: shape, label, shape })),
  });
  const sizes = sizeModel(model, measure);
  const padding = DIAGRAM_METRICS.nodePadding;

  SHAPES.forEach((shape, i) => {
    const size = sizes.nodes[i];
    assert.ok(size !== undefined, shape);
    const w = size.label.width + 2 * padding;
    const h = size.label.height + 2 * padding;

    if (shape === 'diamond') {
      // A centred w × h rectangle fits a W × H diamond when w/W + h/H ≤ 1.
      const fill = w / size.width + h / size.height;
      assert.ok(fill <= 1 + 1e-6, `${shape}: ${fill}`);
      assert.ok(fill >= 0.95, `${shape} is the smallest: ${fill}`);
    } else if (shape === 'circle') {
      assert.ok(close(size.width, size.height, 1), `${shape} is round`);
      const diagonal = Math.hypot(w, h);
      assert.ok(size.width >= diagonal - 1e-6, `${shape} holds the label`);
      assert.ok(size.width <= diagonal + 1, `${shape} is the smallest`);
    } else {
      assert.ok(size.width >= w && size.height >= h, shape);
    }
  });

  const box = sizes.nodes[SHAPES.indexOf('box')];
  const cylinder = sizes.nodes[SHAPES.indexOf('cylinder')];
  assert.ok(
    (cylinder?.height ?? 0) > (box?.height ?? 0),
    'a cylinder adds its caps',
  );
});

test("a group's minimum width is its one-line label plus both side paddings", () => {
  const label = 'Core services of the platform';
  const sizes = sizeModel(
    modelOf({
      nodes: [element('Node', { id: 'n', label: 'N', group: 'g' })],
      groups: [element('Group', { id: 'g', label })],
    }),
    measure,
  );

  assert.deepEqual(sizes.groups[0]?.label.lines, [label]);
  assert.equal(
    sizes.groups[0]?.minWidth,
    measure(label) + 2 * DIAGRAM_METRICS.groupPadding,
  );
});

// Edge ends (F7, geometry.ts).

test('a vertical segment entering a diamond ends on its outline', () => {
  const box: Box = { x: 0, y: 0, width: 100, height: 60 };
  // The diamond's upper-left side at x = 30: |30 − 50| / 50 + |y − 30| / 30 = 1.
  const points: Point[] = [
    { x: 30, y: -100 },
    { x: 30, y: -40 },
    { x: 30, y: 0 },
  ];
  const ended = endOnShape(points, 'end', 'diamond', box);

  assert.equal(ended.length, 3);
  assert.deepEqual(ended.slice(0, 2), points.slice(0, 2));
  assert.ok(close(ended[2]?.x ?? Number.NaN, 30));
  assert.ok(close(ended[2]?.y ?? Number.NaN, 12));
  assert.deepEqual(points[2], { x: 30, y: 0 }, 'the input is not mutated');
});

test('a vertical segment leaving a diamond starts on its outline', () => {
  const box: Box = { x: 0, y: 0, width: 100, height: 60 };
  const ended = endOnShape(
    [
      { x: 30, y: 60 },
      { x: 30, y: 200 },
    ],
    'start',
    'diamond',
    box,
  );

  assert.ok(close(ended[0]?.x ?? Number.NaN, 30));
  assert.ok(close(ended[0]?.y ?? Number.NaN, 48));
  assert.deepEqual(ended[1], { x: 30, y: 200 });
});

test('a vertical segment entering a circle ends on its circle', () => {
  const box: Box = { x: 0, y: 0, width: 100, height: 100 };
  const ended = endOnShape(
    [
      { x: 30, y: -50 },
      { x: 30, y: 0 },
    ],
    'end',
    'circle',
    box,
  );

  // (30 − 50)² + (y − 50)² = 50²
  assert.ok(close(ended[1]?.x ?? Number.NaN, 30));
  assert.ok(close(ended[1]?.y ?? Number.NaN, 50 - Math.sqrt(2100)));
});

test('other shapes, and fewer than two points, are unchanged', () => {
  const box: Box = { x: 0, y: 0, width: 100, height: 60 };
  const points: Point[] = [
    { x: 30, y: -100 },
    { x: 30, y: 0 },
  ];

  for (const shape of ['box', 'round', 'cylinder'] as const) {
    assert.deepEqual(endOnShape(points, 'end', shape, box), points, shape);
  }
  assert.deepEqual(endOnShape([{ x: 30, y: 0 }], 'end', 'diamond', box), [
    { x: 30, y: 0 },
  ]);
});

// Drawing (F7), with a fixed layout result.

/** A result for nodes `n<i>` side by side and edges `e<i>` running between their centres' borders. */
const resultFor = (
  model: FlowchartModel,
  sizes: ReturnType<typeof sizeModel>,
  size: { readonly width?: number; readonly height?: number } = {},
): LayoutResult => {
  const nodes: Record<string, Box> = {};
  model.nodes.forEach((_, i) => {
    const node = sizes.nodes[i] as { width: number; height: number };
    nodes[`n${i}`] = {
      x: 20 + i * 200,
      y: 20,
      width: node.width,
      height: node.height,
    };
  });
  const index = new Map(model.nodes.map((node, i) => [node.id, i]));
  const edges: Record<string, { points: Point[]; label?: Box }> = {};
  model.edges.forEach((edge, i) => {
    const from = nodes[`n${index.get(edge.from)}`] as Box;
    const to = nodes[`n${index.get(edge.to)}`] as Box;
    const label = sizes.edges[i];
    edges[`e${i}`] = {
      points: [
        { x: from.x + from.width, y: from.y + from.height / 2 },
        { x: to.x, y: to.y + to.height / 2 },
      ],
      ...(label === undefined
        ? {}
        : {
            label: {
              x: from.x + from.width + 10,
              y: from.y,
              width: label.width,
              height: label.height,
            },
          }),
    };
  });
  return {
    width: size.width ?? 20 + model.nodes.length * 200,
    height: size.height ?? 200,
    nodes,
    groups: {},
    edges,
  };
};

const draw = async (
  props: Record<string, unknown>,
  size: { readonly width?: number; readonly height?: number } = {},
) => {
  const model = modelOf(props);
  const sizes = sizeModel(model, measure);
  const result = resultFor(model, sizes, size);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(DiagramCanvas, {
        model,
        sizes,
        result,
        interactive: false,
        outlineId: 'outline-1',
      }),
    );
    await settle(10);
  });
  const svg = container.querySelector('svg[role="img"]');
  assert.ok(svg !== null, 'an svg[role="img"] is drawn');
  return {
    container,
    svg,
    result,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

const attribute = (element: Element, name: string, style: string) =>
  element.getAttribute(name) ??
  ((element as HTMLElement).style?.getPropertyValue(style) || null);

const isDashed = (element: Element) => {
  const dashes = attribute(element, 'stroke-dasharray', 'stroke-dasharray');
  return dashes !== null && dashes !== '' && dashes !== 'none';
};

const hasMarker = (element: Element) => {
  const marker = attribute(element, 'marker-end', 'marker-end');
  return marker !== null && marker !== '' && marker !== 'none';
};

test("a round node's corners are rounded by half its height", async () => {
  const drawn = await draw({
    nodes: [element('Node', { id: 'web', label: 'Web app', shape: 'round' })],
  });
  const box = drawn.result.nodes.n0 as Box;

  const rects = [...drawn.svg.querySelectorAll('rect')].filter(
    (rect) =>
      Number(rect.getAttribute('width')) === box.width &&
      Number(rect.getAttribute('height')) === box.height,
  );
  assert.ok(rects.length > 0, 'the node is drawn as a rect of its box');
  assert.ok(
    rects.some((rect) => Number(rect.getAttribute('rx')) === box.height / 2),
    `rx is ${box.height / 2}`,
  );
  await drawn.unmount();
});

test('a dashed edge is dashed, and an edge with arrow "none" has no arrowhead', async () => {
  const nodes = [
    element('Node', { id: 'a', label: 'A' }),
    element('Node', { id: 'b', label: 'B' }),
  ];

  const plain = await draw({
    nodes,
    edges: [element('Edge', { from: 'a', to: 'b' })],
  });
  const plainParts = [...plain.svg.querySelectorAll('*')];
  assert.ok(plainParts.some(hasMarker), 'a solid edge ends in an arrowhead');
  assert.equal(plainParts.some(isDashed), false, 'a solid edge is not dashed');
  await plain.unmount();

  const dashed = await draw({
    nodes,
    edges: [
      element('Edge', { from: 'a', to: 'b', line: 'dashed', arrow: 'none' }),
    ],
  });
  const dashedParts = [...dashed.svg.querySelectorAll('*')];
  assert.ok(dashedParts.some(isDashed), 'the dashed edge is dashed');
  assert.equal(dashedParts.some(hasMarker), false, 'no arrowhead');
  await dashed.unmount();
});

/** The area: the nearest element around the svg with a height in px. */
const areaHeight = (svg: Element): number => {
  for (
    let at: HTMLElement | null = svg.parentElement;
    at !== null;
    at = at.parentElement
  ) {
    const height = /^(\d+(?:\.\d+)?)px$/.exec(at.style.height);
    if (height !== null) return Number(height[1]);
  }
  assert.fail('no element around the svg has a height in px');
};

const withClientWidth = async <T>(
  width: number,
  run: () => Promise<T>,
): Promise<T> => {
  const proto = window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get: () => width,
  });
  try {
    return await run();
  } finally {
    if (original === undefined) {
      delete (proto as { clientWidth?: number }).clientWidth;
    } else {
      Object.defineProperty(proto, 'clientWidth', original);
    }
  }
};

const node = element('Node', { id: 'a', label: 'A' });

test('with a height, the area is that height clamped to 160–1200 px', async () => {
  await withClientWidth(800, async () => {
    for (const [height, expected] of [
      [100, 160],
      [500, 500],
      [2000, 1200],
    ] as const) {
      const drawn = await draw({ nodes: [node], height });
      assert.equal(areaHeight(drawn.svg), expected, `height ${height}`);
      await drawn.unmount();
    }
  });
});

test('without a height, the area is the fitted drawing plus margin, clamped to 160–560 px', async () => {
  await withClientWidth(800, async () => {
    const short = await draw({ nodes: [node] }, { width: 300, height: 20 });
    assert.equal(areaHeight(short.svg), 160);
    await short.unmount();

    const tall = await draw({ nodes: [node] }, { width: 300, height: 5000 });
    assert.equal(areaHeight(tall.svg), 560);
    await tall.unmount();

    // At scale 1 (the drawing is narrower than the area): its height plus
    // the fit margin, 24 px on one or both sides.
    const middle = await draw({ nodes: [node] }, { width: 400, height: 300 });
    const fitted = areaHeight(middle.svg);
    assert.ok(fitted >= 324 && fitted <= 348, `${fitted}`);
    await middle.unmount();

    // Wider than the area: scaled down to fit its width first.
    const wide = await draw({ nodes: [node] }, { width: 1600, height: 600 });
    const scaled = areaHeight(wide.svg);
    assert.ok(scaled >= 306 && scaled <= 348, `${scaled}`);
    await wide.unmount();
  });
});

// FT34 (openui-diagrams-phase2.md F21): sizing entities and topics.

const entityModelOf = (props: Record<string, unknown>): EntityModel =>
  readEntities(props);

test('FT34: under er, an entity is as wide as its widest key column and row, as tall as its header band and rows', () => {
  const model = entityModelOf({
    entities: [
      element('Entity', {
        id: 'users',
        name: 'users',
        fields: [
          element('Field', { name: 'id', type: 'uuid', key: 'pk' }),
          element('Field', { name: 'email', type: 'text', key: 'unique' }),
          element('Field', { name: 'note' }),
        ],
      }),
    ],
  });
  const sizes = sizeEntities(model, measure);
  const { nodePadding, lineHeight } = DIAGRAM_METRICS;

  assert.equal(sizes.keyColumn, measure('PK FK '));
  const entity = sizes.entities[0];
  assert.deepEqual(entity?.rows, ['id uuid', 'email text', 'note']);
  // The widest of the name and key column + row, plus both paddings.
  assert.equal(
    entity?.width,
    Math.max(measure('users'), sizes.keyColumn + measure('email text')) +
      2 * nodePadding,
  );
  // The header band (38 px), a line per row, then padding below.
  assert.equal(entity?.height, 38 + 3 * lineHeight + nodePadding);
  assert.equal(38, lineHeight + 2 * nodePadding);
});

test('FT34: under class, rows read name: type, methods follow, and a method adds the separator', () => {
  const model = entityModelOf({
    notation: 'class',
    entities: [
      element('Entity', {
        id: 'dog',
        name: 'Dog',
        fields: [element('Field', { name: 'name', type: 'string' })],
        methods: ['bark(): void', 'fetch(item: Ball): boolean'],
      }),
      element('Entity', {
        id: 'cat',
        name: 'Cat',
        fields: [element('Field', { name: 'lives', type: 'int' })],
      }),
    ],
  });
  const sizes = sizeEntities(model, measure);
  const { nodePadding, lineHeight } = DIAGRAM_METRICS;

  assert.equal(sizes.keyColumn, 0);
  const [dog, cat] = sizes.entities;
  assert.deepEqual(dog?.rows, [
    'name: string',
    'bark(): void',
    'fetch(item: Ball): boolean',
  ]);
  assert.equal(
    dog?.width,
    measure('fetch(item: Ball): boolean') + 2 * nodePadding,
  );
  assert.equal(dog?.height, 38 + 3 * lineHeight + nodePadding + nodePadding);
  assert.deepEqual(cat?.rows, ['lives: int']);
  assert.equal(
    cat?.height,
    38 + lineHeight + nodePadding,
    'no method, no separator',
  );
});

test("FT34: a relation's label is padded as an edge label; under class each count is a padded 26 px box, under er none", () => {
  const entities = [
    element('Entity', { id: 'a', name: 'A' }),
    element('Entity', { id: 'b', name: 'B' }),
  ];
  const relations = [
    element('Relation', {
      from: 'a',
      to: 'b',
      label: 'places',
      fromCount: '1..*',
      toCount: '1',
    }),
    element('Relation', { from: 'b', to: 'a' }),
  ];
  const { edgeLabelPadding, lineHeight } = DIAGRAM_METRICS;

  const uml = sizeEntities(
    entityModelOf({ notation: 'class', entities, relations }),
    measure,
  );
  assert.equal(
    uml.labels[0]?.boxWidth,
    measure('places') + 2 * edgeLabelPadding,
  );
  assert.equal(uml.labels[0]?.boxHeight, lineHeight + 2 * edgeLabelPadding);
  assert.equal(uml.labels[1], undefined);
  assert.deepEqual(uml.tails[0], { width: measure('1..*') + 8, height: 26 });
  assert.deepEqual(uml.heads[0], { width: measure('1') + 8, height: 26 });
  assert.equal(uml.tails[1], undefined);
  assert.equal(uml.heads[1], undefined);

  const er = sizeEntities(entityModelOf({ entities, relations }), measure);
  assert.deepEqual(er.tails, [undefined, undefined]);
  assert.deepEqual(er.heads, [undefined, undefined]);
});

test('FT34: sizeMindMap sizes a topic as a round node, in preorder', () => {
  const topic = (label: string, children: unknown[] = []) =>
    element('Topic', { label, children });
  const label = 'Plan the launch of the new mobile application';
  const model = readMindMap({ root: topic('Root', [topic(label)]) });
  const sizes = sizeMindMap(model, measure);
  const rounds = sizeModel(
    modelOf({
      nodes: [
        element('Node', { id: 'r', label: 'Root', shape: 'round' }),
        element('Node', { id: 't', label, shape: 'round' }),
      ],
    }),
    measure,
  );

  assert.equal(sizes.topics.length, 2);
  sizes.topics.forEach((size, i) => {
    const round = rounds.nodes[i];
    assert.deepEqual(size.label, round?.label);
    assert.equal(size.width, round?.width);
    assert.equal(size.height, round?.height);
  });
  assert.deepEqual(sizeMindMap(readMindMap({}), measure).topics, []);
});

// FT35 (F20): the entity markers' parts, shapes and fills, drawn with a fixed
// layout result.

const drawEntities = async (props: Record<string, unknown>) => {
  const model = entityModelOf(props);
  const sizes = sizeEntities(model, measure);
  const nodes: Record<string, Box> = {};
  model.entities.forEach((_, i) => {
    const size = sizes.entities[i] as { width: number; height: number };
    nodes[`n${i}`] = {
      x: 20 + i * 400,
      y: 20,
      width: size.width,
      height: size.height,
    };
  });
  const edges: Record<string, { points: Point[] }> = {};
  model.relations.forEach((_, i) => {
    const from = nodes.n0 as Box;
    const to = nodes.n1 as Box;
    const y = 30 + i * 4;
    edges[`e${i}`] = {
      points: [
        { x: from.x + from.width, y },
        { x: to.x, y },
      ],
    };
  });
  const result: LayoutResult = {
    width: 900,
    height: 400,
    nodes,
    groups: {},
    edges,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(EntityPicture, {
        model,
        sizes,
        result,
        outlineId: 'outline-1',
      }),
    );
    await settle(10);
  });
  const svg = container.querySelector('svg[role="img"]');
  assert.ok(svg !== null, 'an svg[role="img"] is drawn');
  return {
    svg,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

const pair = [
  element('Entity', { id: 'a', name: 'A' }),
  element('Entity', { id: 'b', name: 'B' }),
];

const fillOf = (part: Element): string => attribute(part, 'fill', 'fill') ?? '';

/** A marker's parts: its circles, and its other strokes (bars and crow's-foot prongs). */
const partsOf = (marker: Element) => {
  const shapes = [...marker.querySelectorAll('*')].filter(
    (part) => part.tagName.toLowerCase() !== 'g',
  );
  return {
    circles: shapes.filter((part) =>
      ['circle', 'ellipse'].includes(part.tagName.toLowerCase()),
    ),
    strokes: shapes.filter(
      (part) => !['circle', 'ellipse'].includes(part.tagName.toLowerCase()),
    ),
  };
};

test("FT35: under er, each count's crow's-foot marker has F20's parts", async () => {
  const drawn = await drawEntities({
    entities: pair,
    relations: [
      element('Relation', {
        from: 'a',
        to: 'b',
        fromCount: '1',
        toCount: '0..1',
      }),
      element('Relation', {
        from: 'a',
        to: 'b',
        fromCount: '*',
        toCount: '1..*',
      }),
    ],
  });
  const marker = (kind: string) => {
    const found = drawn.svg.querySelectorAll(`[data-marker="${kind}"]`);
    assert.equal(found.length, 1, kind);
    return partsOf(found[0] as Element);
  };

  // `1`: one bar.
  const one = marker('one');
  assert.equal(one.circles.length, 0);
  assert.ok(one.strokes.length >= 1, 'a bar');
  // `0..1`: a circle and a bar.
  const zeroOne = marker('zero-one');
  assert.equal(zeroOne.circles.length, 1);
  assert.ok(zeroOne.strokes.length >= 1, 'a bar');
  // `*`: a circle and a crow's foot.
  const many = marker('many');
  assert.equal(many.circles.length, 1);
  assert.ok(many.strokes.length >= 1, "a crow's foot");
  // `1..*`: a bar and a crow's foot.
  const oneMany = marker('one-many');
  assert.equal(oneMany.circles.length, 0);
  assert.ok(oneMany.strokes.length >= 2, "a bar and a crow's foot");
  // Hollow circles fill with nodeFill.
  for (const circle of [...zeroOne.circles, ...many.circles]) {
    assert.equal(fillOf(circle), cssColor(DIAGRAM_COLORS.nodeFill));
  }
  assert.equal(drawn.svg.querySelectorAll('[data-marker]').length, 4);
  await drawn.unmount();
});

test("FT35: under class, the markers' shapes and fills follow F20's table", async () => {
  const drawn = await drawEntities({
    notation: 'class',
    entities: pair,
    relations: [
      'association',
      'inherits',
      'implements',
      'composition',
      'aggregation',
      'dependency',
    ].map((kind) => element('Relation', { from: 'a', to: 'b', kind })),
  });
  const markers = [...drawn.svg.querySelectorAll('[data-marker]')];
  const kinds = markers.map((marker) => marker.getAttribute('data-marker'));
  assert.deepEqual([...kinds].sort(), [
    'arrow',
    'diamond',
    'diamond',
    'triangle',
    'triangle',
  ]);

  const nodeFill = cssColor(DIAGRAM_COLORS.nodeFill);
  const fills = (marker: Element) =>
    [marker, ...marker.querySelectorAll('*')]
      .map(fillOf)
      .filter((fill) => fill !== '');
  for (const triangle of markers.filter(
    (m) => m.getAttribute('data-marker') === 'triangle',
  )) {
    assert.ok(fills(triangle).includes(nodeFill), 'a hollow triangle');
  }
  const diamonds = markers.filter(
    (m) => m.getAttribute('data-marker') === 'diamond',
  );
  const hollow = diamonds.filter((diamond) =>
    fills(diamond).includes(nodeFill),
  );
  assert.equal(hollow.length, 1, 'aggregation is hollow, composition filled');
  const filled = diamonds.find((diamond) => !fills(diamond).includes(nodeFill));
  assert.ok(
    filled !== undefined && fills(filled).some((fill) => fill !== 'none'),
    'composition is filled',
  );
  const arrow = markers.find(
    (m) => m.getAttribute('data-marker') === 'arrow',
  ) as Element;
  assert.ok(
    fills(arrow).every((fill) => fill === 'none' || fill === 'transparent'),
    'an open arrowhead',
  );
  await drawn.unmount();
});
