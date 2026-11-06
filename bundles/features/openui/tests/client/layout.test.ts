// FT3 and FT7 (openui-diagrams.md F6): the layout chunk's `layout`, the real
// module with the real ELK. A small graph lays out into one coordinate system
// with every key; a graph the chunk cannot accept rejects before ELK runs.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { layout } from '../../src/client/chunks/layout.js';
import type {
  Box,
  LayoutGraph,
  LayoutResult,
  Point,
} from '../../src/client/diagram/layout-types.js';

/** One group holding two nodes, one top-level node, three edges: one labelled, one a self-loop. */
const SMALL: LayoutGraph = {
  direction: 'down',
  groupPadding: { top: 30, side: 12 },
  nodes: [
    { key: 'n0', width: 120, height: 40, group: 'g0' },
    { key: 'n1', width: 100, height: 48, group: 'g0' },
    { key: 'n2', width: 80, height: 40 },
  ],
  groups: [{ key: 'g0', minWidth: 160 }],
  edges: [
    { key: 'e0', from: 'n0', to: 'n1', label: { width: 40, height: 18 } },
    { key: 'e1', from: 'n1', to: 'n2' },
    { key: 'e2', from: 'n2', to: 'n2' },
  ],
};

const TOLERANCE = 0.5;

/** `point` lies on the border of `box`, within the tolerance. */
const onBorder = (point: Point, box: Box): boolean => {
  const inside =
    point.x >= box.x - TOLERANCE &&
    point.x <= box.x + box.width + TOLERANCE &&
    point.y >= box.y - TOLERANCE &&
    point.y <= box.y + box.height + TOLERANCE;
  const nearSide =
    Math.min(
      Math.abs(point.x - box.x),
      Math.abs(point.x - (box.x + box.width)),
      Math.abs(point.y - box.y),
      Math.abs(point.y - (box.y + box.height)),
    ) <= TOLERANCE;
  return inside && nearSide;
};

const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

for (const direction of ['down', 'right'] as const) {
  test(`FT3 (${direction}): every key is laid out, edges run border to border, the group holds its nodes`, async () => {
    const result = await layout({ ...SMALL, direction });

    assert.deepEqual(Object.keys(result.nodes).sort(), ['n0', 'n1', 'n2']);
    assert.deepEqual(Object.keys(result.groups).sort(), ['g0']);
    assert.deepEqual(Object.keys(result.edges).sort(), ['e0', 'e1', 'e2']);
    assert.ok(result.width > 0 && result.height > 0);

    for (const [key, edge] of Object.entries(result.edges)) {
      assert.ok(edge.points.length >= 2, `${key} has at least 2 points`);
      edge.points.slice(1).forEach((point, i) => {
        const previous = edge.points[i] as Point;
        assert.ok(
          point.x !== previous.x || point.y !== previous.y,
          `${key}: no two equal points in a row`,
        );
      });
    }

    for (const { key, from, to } of SMALL.edges.filter(
      (edge) => edge.from !== edge.to,
    )) {
      const points = result.edges[key]?.points ?? [];
      assert.ok(
        onBorder(points[0] as Point, result.nodes[from] as Box),
        `${key} starts on ${from}'s border`,
      );
      assert.ok(
        onBorder(points.at(-1) as Point, result.nodes[to] as Box),
        `${key} ends on ${to}'s border`,
      );
    }

    const label = result.edges.e0?.label;
    assert.ok(label !== undefined, 'the labelled edge has a label box');
    assert.ok(label.width > 0 && label.height > 0);

    const group = result.groups.g0 as Box;
    for (const node of ['n0', 'n1']) {
      assert.ok(
        contains(group, result.nodes[node] as Box),
        `g0 contains ${node}`,
      );
    }
  });
}

const invalid = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('Invalid layout graph:');

test('FT7: a repeated key rejects as an invalid layout graph', async () => {
  await assert.rejects(
    layout({
      ...SMALL,
      nodes: [...SMALL.nodes, { key: 'n0', width: 50, height: 40 }],
    }),
    invalid,
  );
  await assert.rejects(
    layout({
      ...SMALL,
      edges: [...SMALL.edges, { key: 'n2', from: 'n0', to: 'n2' }],
    }),
    invalid,
  );
});

test('FT7: an edge to a missing node rejects as an invalid layout graph', async () => {
  await assert.rejects(
    layout({
      ...SMALL,
      edges: [...SMALL.edges, { key: 'e3', from: 'n0', to: 'n9' }],
    }),
    invalid,
  );
});

test('FT7: a node in a missing group rejects as an invalid layout graph', async () => {
  await assert.rejects(
    layout({
      ...SMALL,
      nodes: [
        ...SMALL.nodes,
        { key: 'n3', width: 50, height: 40, group: 'g9' },
      ],
    }),
    invalid,
  );
});

test('FT7: a loop of group parents rejects as an invalid layout graph', async () => {
  await assert.rejects(
    layout({
      ...SMALL,
      groups: [
        { key: 'g0', parent: 'g1', minWidth: 60 },
        { key: 'g1', parent: 'g0', minWidth: 60 },
      ],
    }),
    invalid,
  );
});

// FT19 (openui-diagrams-phase2.md F18): `mrtree` lays out a tree, and rejects
// anything that is not one, or that carries `layered`'s options.

/** One root and three children, laid out by ELK's mrtree. */
const TREE: LayoutGraph = {
  algorithm: 'mrtree',
  direction: 'down',
  groupPadding: { top: 30, side: 12 },
  nodes: [
    { key: 'n0', width: 120, height: 34 },
    { key: 'n1', width: 80, height: 30 },
    { key: 'n2', width: 100, height: 30 },
    { key: 'n3', width: 60, height: 30 },
  ],
  groups: [],
  edges: [
    { key: 'e1', from: 'n0', to: 'n1' },
    { key: 'e2', from: 'n0', to: 'n2' },
    { key: 'e3', from: 'n0', to: 'n3' },
  ],
};

for (const direction of ['down', 'right'] as const) {
  test(`FT19 (${direction}): an mrtree graph lays out every key, its children ${direction === 'down' ? 'below' : 'right of'} the root`, async () => {
    const result = await layout({ ...TREE, direction });

    assert.deepEqual(Object.keys(result.nodes).sort(), [
      'n0',
      'n1',
      'n2',
      'n3',
    ]);
    assert.deepEqual(Object.keys(result.edges).sort(), ['e1', 'e2', 'e3']);
    const root = result.nodes.n0 as Box;
    for (const key of ['n1', 'n2', 'n3']) {
      const child = result.nodes[key] as Box;
      if (direction === 'down') {
        assert.ok(child.y >= root.y + root.height, `${key} lies below n0`);
      } else {
        assert.ok(child.x >= root.x + root.width, `${key} lies right of n0`);
      }
    }
    for (const [key, edge] of Object.entries(result.edges)) {
      assert.ok(edge.points.length >= 2, `${key} has at least 2 points`);
    }
  });
}

const rejectsWith = (problem: string) => (error: unknown) =>
  error instanceof Error &&
  error.message === `Invalid layout graph: ${problem}`;

test('FT19: an mrtree graph with a group is not a tree', async () => {
  await assert.rejects(
    layout({
      ...TREE,
      nodes: TREE.nodes.map((node) =>
        node.key === 'n1' ? { ...node, group: 'g0' } : node,
      ),
      groups: [{ key: 'g0', minWidth: 80 }],
    }),
    rejectsWith('the graph is not a tree'),
  );
});

test('FT19: an mrtree graph with a node of two parents is not a tree', async () => {
  await assert.rejects(
    layout({
      ...TREE,
      edges: [...TREE.edges, { key: 'e4', from: 'n1', to: 'n2' }],
    }),
    rejectsWith('the graph is not a tree'),
  );
});

test('FT19: an mrtree graph with a two-node edge loop is not a tree', async () => {
  await assert.rejects(
    layout({
      ...TREE,
      nodes: [
        { key: 'a', width: 60, height: 30 },
        { key: 'b', width: 60, height: 30 },
      ],
      edges: [
        { key: 'ab', from: 'a', to: 'b' },
        { key: 'ba', from: 'b', to: 'a' },
      ],
    }),
    rejectsWith('the graph is not a tree'),
  );
});

test("FT19: an mrtree graph with markerSpacing, transposeRight or an end label rejects with layered's options", async () => {
  const problem = rejectsWith('layered options on an mrtree graph');
  await assert.rejects(layout({ ...TREE, markerSpacing: true }), problem);
  await assert.rejects(layout({ ...TREE, transposeRight: true }), problem);
  await assert.rejects(
    layout({
      ...TREE,
      edges: TREE.edges.map((edge, i) =>
        i === 0 ? { ...edge, tailLabel: { width: 16, height: 26 } } : edge,
      ),
    }),
    problem,
  );
});

// FT24 (F18): end labels, the transposed `right` layout and the marker
// options of a `layered` graph.

/** Two entities joined by a relation with a centre label and both end labels. */
const ENDS: LayoutGraph = {
  algorithm: 'layered',
  markerSpacing: true,
  transposeRight: true,
  direction: 'down',
  groupPadding: { top: 30, side: 12 },
  nodes: [
    { key: 'n0', width: 160, height: 92 },
    { key: 'n1', width: 120, height: 74 },
  ],
  groups: [],
  edges: [
    {
      key: 'e0',
      from: 'n0',
      to: 'n1',
      label: { width: 56, height: 26 },
      tailLabel: { width: 16, height: 26 },
      headLabel: { width: 24, height: 26 },
    },
  ],
};

const centre = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

for (const direction of ['down', 'right'] as const) {
  test(`FT24 (${direction}): end labels are placed, each nearer its own end`, async () => {
    const result = await layout({ ...ENDS, direction });
    const edge = result.edges.e0;
    assert.ok(edge !== undefined, 'e0 is laid out');
    assert.ok(edge.label !== undefined, 'the centre label');
    assert.ok(edge.tailLabel !== undefined, 'the tail label');
    assert.ok(edge.headLabel !== undefined, 'the head label');

    const first = edge.points[0] as Point;
    const last = edge.points.at(-1) as Point;
    const tail = centre(edge.tailLabel);
    const head = centre(edge.headLabel);
    assert.ok(
      distance(tail, first) < distance(tail, last),
      'the tail label sits nearer the first point',
    );
    assert.ok(
      distance(head, last) < distance(head, first),
      'the head label sits nearer the last point',
    );
  });
}

const swapSize = <T extends { width: number; height: number }>(size: T): T => ({
  ...size,
  width: size.height,
  height: size.width,
});
const swapBox = (box: Box): Box => ({
  x: box.y,
  y: box.x,
  width: box.height,
  height: box.width,
});
const swapPoint = (point: Point): Point => ({ x: point.y, y: point.x });

/** The graph with every width and height swapped, laid out `down`. */
const swappedDown = (graph: LayoutGraph): LayoutGraph => ({
  ...graph,
  direction: 'down',
  nodes: graph.nodes.map(swapSize),
  edges: graph.edges.map((edge) => ({
    ...edge,
    ...(edge.label === undefined ? {} : { label: swapSize(edge.label) }),
    ...(edge.tailLabel === undefined
      ? {}
      : { tailLabel: swapSize(edge.tailLabel) }),
    ...(edge.headLabel === undefined
      ? {}
      : { headLabel: swapSize(edge.headLabel) }),
  })),
});

/** Every box and point of `result` with x and y, width and height swapped. */
const transposed = (result: LayoutResult): LayoutResult => ({
  width: result.height,
  height: result.width,
  nodes: Object.fromEntries(
    Object.entries(result.nodes).map(([key, box]) => [key, swapBox(box)]),
  ),
  groups: Object.fromEntries(
    Object.entries(result.groups).map(([key, box]) => [key, swapBox(box)]),
  ),
  edges: Object.fromEntries(
    Object.entries(result.edges).map(([key, edge]) => [
      key,
      {
        points: edge.points.map(swapPoint),
        ...(edge.label === undefined ? {} : { label: swapBox(edge.label) }),
        ...(edge.tailLabel === undefined
          ? {}
          : { tailLabel: swapBox(edge.tailLabel) }),
        ...(edge.headLabel === undefined
          ? {}
          : { headLabel: swapBox(edge.headLabel) }),
      },
    ]),
  ),
});

test('FT24: with transposeRight, right is the transposed down layout of the swapped graph, with and without end labels', async () => {
  const plain: LayoutGraph = {
    ...ENDS,
    edges: [
      { key: 'e0', from: 'n0', to: 'n1', label: { width: 56, height: 26 } },
    ],
  };
  for (const [name, graph] of [
    ['end labels', ENDS],
    ['no end label', plain],
  ] as const) {
    const right = await layout({ ...graph, direction: 'right' });
    const down = await layout(swappedDown(graph));

    assert.deepEqual(right, transposed(down), name);
  }
});

test('FT24: with markerSpacing, a self-edge and an edge between adjacent layers have end segments of at least 18 px', async () => {
  const graph: LayoutGraph = {
    algorithm: 'layered',
    markerSpacing: true,
    direction: 'down',
    groupPadding: { top: 30, side: 12 },
    nodes: [
      { key: 'n0', width: 120, height: 60 },
      { key: 'n1', width: 120, height: 60 },
    ],
    groups: [],
    edges: [
      { key: 'e0', from: 'n0', to: 'n1' },
      { key: 'e1', from: 'n1', to: 'n1' },
    ],
  };
  for (const direction of ['down', 'right'] as const) {
    const result = await layout({ ...graph, direction });
    for (const key of ['e0', 'e1']) {
      const points = result.edges[key]?.points ?? [];
      assert.ok(points.length >= 2, `${direction} ${key} is routed`);
      const start = distance(points[0] as Point, points[1] as Point);
      const end = distance(points.at(-2) as Point, points.at(-1) as Point);
      assert.ok(start >= 18, `${direction} ${key} starts with ${start} px`);
      assert.ok(end >= 18, `${direction} ${key} ends with ${end} px`);
    }
  }
});

test('FT24: end labels with groups reject', async () => {
  await assert.rejects(
    layout({
      ...SMALL,
      edges: SMALL.edges.map((edge, i) =>
        i === 1 ? { ...edge, headLabel: { width: 16, height: 26 } } : edge,
      ),
    }),
    rejectsWith('end labels with groups'),
  );
});
