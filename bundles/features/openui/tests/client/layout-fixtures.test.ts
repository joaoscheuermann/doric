// FT4, FT5 and FT6 (openui-diagrams.md F5, F6; G3 a, FR1, A4): the random
// fixtures of the measurement method, read by `readFlowchart`, sized under
// the estimate (happy-dom has no canvas) and laid out by the real layout
// chunk, in both directions. No part overlaps another it does not contain, no
// edge crosses a box, every group is wide enough for its label, and the same
// graph always gives the same picture. Time is not asserted.

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { layout } from '../../src/client/chunks/layout.js';
import {
  type EntityModel,
  readEntities,
} from '../../src/client/diagram/entity-model.js';
import {
  entityGraph,
  mindMapGraph,
  toLayoutGraph,
} from '../../src/client/diagram/graph.js';
import type {
  Box,
  LayoutGraph,
  LayoutResult,
  Point,
} from '../../src/client/diagram/layout-types.js';
import {
  createMeasure,
  sizeEntities,
  sizeMindMap,
  sizeModel,
} from '../../src/client/diagram/measure.js';
import { readMindMap } from '../../src/client/diagram/mindmap-model.js';
import { readFlowchart } from '../../src/client/diagram/model.js';
import { closeWindow } from './support/dom.js';
import {
  type Fixture,
  randomEntityDiagram,
  randomFlowchart,
  randomMindMap,
} from './support/random-graph.js';

after(closeWindow);

const FIXTURES: readonly (Fixture & { readonly name: string })[] = [
  { name: '20/28/4/2', nodes: 20, edges: 28, groups: 4, depth: 2 },
  { name: '50/70/none', nodes: 50, edges: 70, groups: 0, depth: 0 },
  { name: '50/70/10/3', nodes: 50, edges: 70, groups: 10, depth: 3 },
  { name: '100/200/25/4', nodes: 100, edges: 200, groups: 25, depth: 4 },
];

const SEEDS = [1, 2, 3, 4, 5].map((s) => 7919 * s);
const DIRECTIONS = ['down', 'right'] as const;

interface Case {
  readonly name: string;
  readonly graph: LayoutGraph;
}

/** The layout graph of one fixture, seed and direction, sized as F5 sizes it. */
const graphOf = async (
  fixture: Fixture,
  seed: number,
  direction: 'down' | 'right',
): Promise<LayoutGraph> => {
  const props = {
    ...(randomFlowchart(fixture, seed) as object),
    direction,
  };
  const model = readFlowchart(props);
  const measure = await createMeasure('');
  return toLayoutGraph(model, sizeModel(model, measure));
};

let laidOut:
  | Promise<readonly (Case & { readonly result: LayoutResult })[]>
  | undefined;

/** Every case laid out once, shared by FT4 and FT5. */
const allLaidOut = () => {
  laidOut ??= (async () => {
    const cases: (Case & { result: LayoutResult })[] = [];
    for (const fixture of FIXTURES) {
      for (const seed of SEEDS) {
        for (const direction of DIRECTIONS) {
          const graph = await graphOf(fixture, seed, direction);
          cases.push({
            name: `${fixture.name} seed ${seed} ${direction}`,
            graph,
            result: await layout(graph),
          });
        }
      }
    }
    return cases;
  })();
  return laidOut;
};

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const shrink = (box: Box, by: number): Box => ({
  x: box.x + by,
  y: box.y + by,
  width: box.width - 2 * by,
  height: box.height - 2 * by,
});

/** The segment from `a` to `b` passes through the open interior of `box` (Liang–Barsky). */
const crosses = (a: Point, b: Point, box: Box): boolean => {
  if (box.width <= 0 || box.height <= 0) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let low = 0;
  let high = 1;
  const sides: [number, number][] = [
    [-dx, a.x - box.x],
    [dx, box.x + box.width - a.x],
    [-dy, a.y - box.y],
    [dy, box.y + box.height - a.y],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > high) return false;
      if (t > low) low = t;
    } else {
      if (t < low) return false;
      if (t < high) high = t;
    }
  }
  return low < high;
};

/** The keys of `group` and every group around it. */
const ancestors = (graph: LayoutGraph, group: string | undefined): string[] => {
  const parents = new Map(graph.groups.map((g) => [g.key, g.parent]));
  const chain: string[] = [];
  for (let at = group; at !== undefined; at = parents.get(at)) {
    chain.push(at);
  }
  return chain;
};

test('FT4: no part overlaps a part it does not contain, and no edge crosses a box', async () => {
  const problems: string[] = [];

  for (const { name, graph, result } of await allLaidOut()) {
    const nodes = graph.nodes.map((node) => ({
      ...node,
      box: result.nodes[node.key] as Box,
    }));
    const groups = graph.groups.map((group) => ({
      ...group,
      box: result.groups[group.key] as Box,
      around: ancestors(graph, group.key),
    }));

    for (const [i, a] of nodes.entries()) {
      for (const b of nodes.slice(i + 1)) {
        if (overlaps(a.box, b.box)) {
          problems.push(`${name}: nodes ${a.key} and ${b.key} overlap`);
        }
      }
      const holders = ancestors(graph, a.group);
      for (const group of groups) {
        if (!holders.includes(group.key) && overlaps(a.box, group.box)) {
          problems.push(`${name}: node ${a.key} overlaps group ${group.key}`);
        }
      }
    }

    for (const [i, a] of groups.entries()) {
      for (const b of groups.slice(i + 1)) {
        const nested = a.around.includes(b.key) || b.around.includes(a.key);
        if (!nested && overlaps(a.box, b.box)) {
          problems.push(`${name}: groups ${a.key} and ${b.key} overlap`);
        }
      }
    }

    for (const edge of graph.edges) {
      const drawn = result.edges[edge.key];
      if (drawn === undefined) {
        problems.push(`${name}: edge ${edge.key} is missing`);
        continue;
      }
      for (const node of nodes) {
        if (node.key === edge.from || node.key === edge.to) continue;
        const inner = shrink(node.box, 2);
        drawn.points.slice(1).forEach((point, i) => {
          if (crosses(drawn.points[i] as Point, point, inner)) {
            problems.push(`${name}: edge ${edge.key} crosses node ${node.key}`);
          }
        });
      }
      if (drawn.label !== undefined) {
        for (const node of nodes) {
          if (overlaps(drawn.label, node.box)) {
            problems.push(
              `${name}: label of edge ${edge.key} overlaps node ${node.key}`,
            );
          }
        }
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('FT5: every group is at least its minWidth wide, in both directions', async () => {
  const problems: string[] = [];

  for (const { name, graph, result } of await allLaidOut()) {
    for (const group of graph.groups) {
      const box = result.groups[group.key];
      if (box === undefined || box.width < group.minWidth) {
        problems.push(
          `${name}: group ${group.key} is ${box?.width} wide, under ${group.minWidth}`,
        );
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('FT6: the same graph laid out twice gives the same result', async () => {
  for (const fixture of FIXTURES) {
    for (const direction of DIRECTIONS) {
      const graph = await graphOf(fixture, SEEDS[0] as number, direction);
      const first = await layout(graph);
      const second = await layout(graph);

      assert.deepEqual(second, first, `${fixture.name} ${direction}`);
    }
  }
});

// FT23 (openui-diagrams-phase2.md F18, M10; G3 a): the mind-map fixtures,
// read, sized under the estimate and laid out by the real chunk with mrtree in
// both layouts. No two topics overlap, no edge crosses a topic other than its
// ends, and the same map always gives the same picture.

const MIND_MAPS = [
  { name: '30/3', topics: 30, depth: 3 },
  { name: '100/5', topics: 100, depth: 5 },
  { name: '300/8', topics: 300, depth: 8 },
] as const;
const LAYOUTS = ['right', 'down'] as const;

const mindMapGraphOf = async (
  shape: { topics: number; depth: number },
  seed: number,
  mapLayout: 'right' | 'down',
): Promise<LayoutGraph> => {
  const model = readMindMap(randomMindMap(shape, seed, mapLayout));
  const measure = await createMeasure('');
  return mindMapGraph(model, sizeMindMap(model, measure));
};

/** Boxes that overlap, and edge segments through a node other than their ends. */
const treeProblems = (
  name: string,
  graph: LayoutGraph,
  result: LayoutResult,
): string[] => {
  const problems: string[] = [];
  const nodes = graph.nodes.map((node) => ({
    key: node.key,
    box: result.nodes[node.key] as Box,
  }));
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) {
      if (overlaps(a.box, b.box)) {
        problems.push(`${name}: topics ${a.key} and ${b.key} overlap`);
      }
    }
  }
  for (const edge of graph.edges) {
    const drawn = result.edges[edge.key];
    if (drawn === undefined) {
      problems.push(`${name}: edge ${edge.key} is missing`);
      continue;
    }
    for (const node of nodes) {
      if (node.key === edge.from || node.key === edge.to) continue;
      const inner = shrink(node.box, 2);
      drawn.points.slice(1).forEach((point, i) => {
        if (crosses(drawn.points[i] as Point, point, inner)) {
          problems.push(`${name}: edge ${edge.key} crosses topic ${node.key}`);
        }
      });
    }
  }
  return problems;
};

test('FT23: no two topics overlap and no edge crosses a topic, every mind-map fixture, both layouts', async () => {
  const problems: string[] = [];
  for (const shape of MIND_MAPS) {
    for (const seed of SEEDS) {
      for (const mapLayout of LAYOUTS) {
        const graph = await mindMapGraphOf(shape, seed, mapLayout);
        const name = `${shape.name} seed ${seed} ${mapLayout}`;
        assert.equal(graph.nodes.length, shape.topics, `${name}: every topic`);
        problems.push(...treeProblems(name, graph, await layout(graph)));
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('FT23: the same mind map laid out twice gives the same result', async () => {
  for (const shape of MIND_MAPS) {
    for (const mapLayout of LAYOUTS) {
      const graph = await mindMapGraphOf(shape, SEEDS[0] as number, mapLayout);
      const first = await layout(graph);
      const second = await layout(graph);

      assert.deepEqual(second, first, `${shape.name} ${mapLayout}`);
    }
  }
});

// FT27 (F18, F20, M9; G3 a, FR20): the entity fixtures, read, sized under the
// estimate and laid out by the real chunk, under er and class, in both
// directions. Zero defects of each kind; touching markers counted against M9.
// M9's tolerances: labels overlapping by under 1 px and markers by under
// 0.5 px touch and are not defects; boxes and routes get only float error.

/** Overlap a part must exceed on both axes to count: labels, markers, float error. */
const LABEL_SLACK = 1;
const MARKER_SLACK = 0.5;
const FLOAT_SLACK = 1e-6;

/** `a` and `b` overlap by more than `slack` on both axes. */
const overlapsBy = (a: Box, b: Box, slack: number): boolean =>
  a.x + slack < b.x + b.width &&
  b.x + slack < a.x + a.width &&
  a.y + slack < b.y + b.height &&
  b.y + slack < a.y + a.height;

const ENTITY_FIXTURES = [
  { name: '10/12', entities: 10, relations: 12 },
  { name: '30/50', entities: 30, relations: 50 },
  { name: '60/120', entities: 60, relations: 120 },
] as const;
const NOTATIONS = ['er', 'class'] as const;

/** F20's marker boxes along the line from the end, length × width. */
const MARKER_SIZES: Readonly<
  Record<string, { length: number; width: number }>
> = {
  '1': { length: 8, width: 12 },
  '0..1': { length: 14, width: 12 },
  '*': { length: 18, width: 12 },
  '1..*': { length: 12, width: 12 },
  triangle: { length: 12, width: 12 },
  diamond: { length: 16, width: 10 },
  arrow: { length: 10, width: 10 },
};

/**
 * M9's counts per fixture set (5 seeds), re-measured with the spec's layout
 * options (F18, including `elk.hierarchyHandling` `INCLUDE_CHILDREN`) and
 * M9's tolerances: pairs of intersecting marker boxes, and marker boxes under
 * another relation's end label, neither counting a self-relation's marker or
 * label (M9 counted those apart); FR20's ceiling.
 */
const M9: Readonly<
  Record<string, { readonly markers: number; readonly labels: number }>
> = {
  'er down 10/12': { markers: 0, labels: 0 },
  'er down 30/50': { markers: 0, labels: 0 },
  'er down 60/120': { markers: 0, labels: 0 },
  'er right 10/12': { markers: 0, labels: 0 },
  'er right 30/50': { markers: 10, labels: 0 },
  'er right 60/120': { markers: 22, labels: 0 },
  'class down 10/12': { markers: 0, labels: 2 },
  'class down 30/50': { markers: 0, labels: 13 },
  'class down 60/120': { markers: 0, labels: 37 },
  'class right 10/12': { markers: 0, labels: 9 },
  'class right 30/50': { markers: 0, labels: 48 },
  'class right 60/120': { markers: 3, labels: 129 },
};

interface EntityCase {
  readonly model: EntityModel;
  readonly graph: LayoutGraph;
}

const entityCaseOf = async (
  shape: { entities: number; relations: number },
  seed: number,
  notation: 'er' | 'class',
  direction: 'down' | 'right',
): Promise<EntityCase> => {
  const props = {
    ...(randomEntityDiagram(shape, seed, notation) as object),
    direction,
  };
  const model = readEntities(props);
  const measure = await createMeasure('');
  return { model, graph: entityGraph(model, sizeEntities(model, measure)) };
};

interface Marker {
  readonly relation: number;
  /** The relation joins an entity to itself. */
  readonly self: boolean;
  /** The entity key of the end the marker sits at. */
  readonly at: string;
  readonly box: Box;
  /** The end segment's length, and the marker's. */
  readonly segment: number;
  readonly length: number;
}

/** The box `length` along the segment from `end` towards `next`, `width` across it. */
const markerBox = (
  end: Point,
  next: Point,
  length: number,
  width: number,
): Box => {
  const dx = next.x - end.x;
  const dy = next.y - end.y;
  const norm = Math.hypot(dx, dy) || 1;
  const ux = dx / norm;
  const uy = dy / norm;
  const corners = [
    { x: end.x - (uy * width) / 2, y: end.y + (ux * width) / 2 },
    { x: end.x + (uy * width) / 2, y: end.y - (ux * width) / 2 },
  ].flatMap((corner) => [
    corner,
    { x: corner.x + ux * length, y: corner.y + uy * length },
  ]);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/** Every marker F20 draws for `model`, at its end of `result`'s route. */
const markersOf = (model: EntityModel, result: LayoutResult): Marker[] => {
  const keyOf = new Map(
    model.entities.map((entity, i) => [entity.id, `n${i}`]),
  );
  const markers: Marker[] = [];
  model.relations.forEach((relation, i) => {
    const points = result.edges[`e${i}`]?.points ?? [];
    if (points.length < 2) return;
    const reversed =
      model.notation === 'class' &&
      (relation.kind === 'inherits' || relation.kind === 'implements');
    // The route's first point is at the model's `from`, unless reversed.
    const ends = {
      from: reversed
        ? { end: points.at(-1) as Point, next: points.at(-2) as Point }
        : { end: points[0] as Point, next: points[1] as Point },
      to: reversed
        ? { end: points[0] as Point, next: points[1] as Point }
        : { end: points.at(-1) as Point, next: points.at(-2) as Point },
    };
    const kinds: { from?: string; to?: string } =
      model.notation === 'er'
        ? { from: relation.fromCount, to: relation.toCount }
        : relation.kind === 'inherits' || relation.kind === 'implements'
          ? { to: 'triangle' }
          : relation.kind === 'composition' || relation.kind === 'aggregation'
            ? { from: 'diamond' }
            : relation.kind === 'dependency'
              ? { to: 'arrow' }
              : {};
    for (const side of ['from', 'to'] as const) {
      const kind = kinds[side];
      if (kind === undefined) continue;
      const size = MARKER_SIZES[kind] as { length: number; width: number };
      const { end, next } = ends[side];
      markers.push({
        relation: i,
        self: relation.from === relation.to,
        at: keyOf.get(relation[side]) ?? '',
        box: markerBox(end, next, size.length, size.width),
        segment: Math.hypot(next.x - end.x, next.y - end.y),
        length: size.length,
      });
    }
  });
  return markers;
};

interface EntityReport {
  readonly problems: string[];
  readonly markerPairs: number;
  readonly markersUnderLabels: number;
}

const entityReport = (
  name: string,
  { model, graph }: EntityCase,
  result: LayoutResult,
): EntityReport => {
  const problems: string[] = [];
  const nodes = graph.nodes.map((node) => ({
    key: node.key,
    box: result.nodes[node.key] as Box,
  }));
  for (const [i, a] of nodes.entries()) {
    for (const b of nodes.slice(i + 1)) {
      if (overlapsBy(a.box, b.box, FLOAT_SLACK)) {
        problems.push(`${name}: entities ${a.key} and ${b.key} overlap`);
      }
    }
  }

  const labels: { edge: string; box: Box }[] = [];
  for (const edge of graph.edges) {
    const drawn = result.edges[edge.key];
    if (drawn === undefined) {
      problems.push(`${name}: relation ${edge.key} is missing`);
      continue;
    }
    for (const node of nodes) {
      if (node.key === edge.from || node.key === edge.to) continue;
      const inner = shrink(node.box, 2);
      drawn.points.slice(1).forEach((point, i) => {
        if (crosses(drawn.points[i] as Point, point, inner)) {
          problems.push(
            `${name}: relation ${edge.key} crosses entity ${node.key}`,
          );
        }
      });
    }
    for (const box of [drawn.label, drawn.tailLabel, drawn.headLabel]) {
      if (box === undefined) continue;
      labels.push({ edge: edge.key, box });
      for (const node of nodes) {
        if (overlapsBy(box, node.box, LABEL_SLACK)) {
          problems.push(
            `${name}: a label of ${edge.key} lies on entity ${node.key}`,
          );
        }
      }
    }
  }
  for (const [i, a] of labels.entries()) {
    for (const b of labels.slice(i + 1)) {
      if (overlapsBy(a.box, b.box, LABEL_SLACK)) {
        problems.push(`${name}: labels of ${a.edge} and ${b.edge} overlap`);
      }
    }
  }

  const markers = markersOf(model, result);
  for (const marker of markers) {
    if (marker.segment < marker.length - 1e-6) {
      problems.push(
        `${name}: e${marker.relation}'s end segment at ${marker.at} is ${marker.segment} px, under its marker's ${marker.length}`,
      );
    }
    for (const node of nodes) {
      if (node.key === marker.at) continue;
      if (overlapsBy(marker.box, node.box, MARKER_SLACK)) {
        problems.push(
          `${name}: a marker of e${marker.relation} lies on entity ${node.key}`,
        );
      }
    }
  }
  const counted = markers.filter((marker) => !marker.self);
  let markerPairs = 0;
  for (const [i, a] of counted.entries()) {
    for (const b of counted.slice(i + 1)) {
      if (overlapsBy(a.box, b.box, MARKER_SLACK)) markerPairs += 1;
    }
  }
  let markersUnderLabels = 0;
  for (const marker of counted) {
    model.relations.forEach((relation, i) => {
      if (i === marker.relation || relation.from === relation.to) return;
      const edge = result.edges[`e${i}`];
      for (const box of [edge?.tailLabel, edge?.headLabel]) {
        if (box !== undefined && overlapsBy(marker.box, box, MARKER_SLACK))
          markersUnderLabels += 1;
      }
    });
  }
  return { problems, markerPairs, markersUnderLabels };
};

test('FT27: no entity, relation, label or marker defect, every entity fixture, both notations and directions; touching markers within M9', async () => {
  const problems: string[] = [];
  const over: string[] = [];
  for (const notation of NOTATIONS) {
    for (const direction of DIRECTIONS) {
      for (const shape of ENTITY_FIXTURES) {
        const set = `${notation} ${direction} ${shape.name}`;
        let markerPairs = 0;
        let markersUnderLabels = 0;
        for (const seed of SEEDS) {
          const entityCase = await entityCaseOf(
            shape,
            seed,
            notation,
            direction,
          );
          const report = entityReport(
            `${set} seed ${seed}`,
            entityCase,
            await layout(entityCase.graph),
          );
          problems.push(...report.problems);
          markerPairs += report.markerPairs;
          markersUnderLabels += report.markersUnderLabels;
        }
        const ceiling = M9[set] as { markers: number; labels: number };
        if (markerPairs > ceiling.markers) {
          over.push(
            `${set}: ${markerPairs} intersecting marker pairs, M9 ${ceiling.markers}`,
          );
        }
        if (markersUnderLabels > ceiling.labels) {
          over.push(
            `${set}: ${markersUnderLabels} markers under an end label, M9 ${ceiling.labels}`,
          );
        }
      }
    }
  }

  assert.deepEqual(problems, []);
  assert.deepEqual(over, []);
});

test('FT27: the same entity diagram laid out twice gives the same result', async () => {
  for (const notation of NOTATIONS) {
    for (const direction of DIRECTIONS) {
      for (const shape of ENTITY_FIXTURES) {
        const { graph } = await entityCaseOf(
          shape,
          SEEDS[0] as number,
          notation,
          direction,
        );
        const first = await layout(graph);
        const second = await layout(graph);

        assert.deepEqual(
          second,
          first,
          `${notation} ${direction} ${shape.name}`,
        );
      }
    }
  }
});
