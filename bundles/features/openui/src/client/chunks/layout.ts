/*!
 * This file contains elkjs 0.11.1 (https://github.com/kieler/elkjs), the
 * JavaScript build of the Eclipse Layout Kernel (https://github.com/eclipse-elk/elk),
 * bundled and syntax-minified by esbuild and not otherwise modified by Doric.
 * elkjs is distributed here under the Eclipse Public License 2.0
 * (https://www.eclipse.org/legal/epl-2.0). Its Source Code is available under
 * that license at https://github.com/kieler/elkjs/tree/0.11.1 and
 * https://github.com/eclipse-elk/elk.
 *
 * Copyright (c) 2017 Kiel University and others.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Copyright (c) 2021 Kiel University and others.
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Doric's own code in this file is under the MIT License.
 */

// The layout chunk (openui-diagrams.md F6, F11), built as its own file and
// imported by the renderer chunk's layout loader at a window's first
// layout: ELK `layered` with hierarchy handling and orthogonal routing, or
// ELK `mrtree` for trees, behind one `layout(graph)`. It imports no relative module by value.

import ElkBundled from 'elkjs/lib/elk.bundled.js';
import type {
  ELK,
  ElkExtendedEdge,
  ElkNode,
  LayoutOptions,
} from 'elkjs/lib/elk-api.js';

import type {
  Box,
  LayoutGraph,
  LayoutResult,
  Point,
} from '../diagram/layout-types.js';

/** A group's minimum extent across the direction of flow, in px. */
const GROUP_MIN_DEPTH = 48;

/** Under `module: nodenext` the CommonJS default import types as the module; at run time it is the constructor. */
const ElkConstructor = ElkBundled as unknown as new () => ELK;

let elk: ELK | undefined;

/**
 * Why an `mrtree` graph is not one tree ELK's mrtree lays out: a group, a node with two
 * incoming edges or an edge loop; or why it carries `layered`'s options.
 */
const treeProblemOf = (graph: LayoutGraph): string | undefined => {
  const parents = new Map<string, string>();
  for (const edge of graph.edges) {
    if (parents.has(edge.to)) return 'the graph is not a tree';
    parents.set(edge.to, edge.from);
  }
  const looped = graph.nodes.some((node) => {
    let at = parents.get(node.key);
    for (let step = 0; at !== undefined; step += 1) {
      if (at === node.key || step > graph.nodes.length) return true;
      at = parents.get(at);
    }
    return false;
  });
  if (graph.groups.length > 0 || looped) return 'the graph is not a tree';
  const layered =
    graph.markerSpacing === true ||
    graph.transposeRight === true ||
    graph.edges.some(
      (edge) => edge.tailLabel !== undefined || edge.headLabel !== undefined,
    );
  return layered ? 'layered options on an mrtree graph' : undefined;
};

/** The first problem that makes `graph` one ELK cannot lay out, if any. */
const problemOf = (graph: LayoutGraph): string | undefined => {
  const keys = [
    ...graph.nodes.map((node) => node.key),
    ...graph.groups.map((group) => group.key),
    ...graph.edges.map((edge) => edge.key),
  ];
  const repeated = keys.find((key, i) => keys.indexOf(key) !== i);
  if (repeated !== undefined) return `the key ${repeated} is repeated`;

  const groups = new Map(graph.groups.map((group) => [group.key, group]));
  const nodes = new Set(graph.nodes.map((node) => node.key));
  const missing =
    graph.nodes.find(
      (node) => node.group !== undefined && !groups.has(node.group),
    ) ??
    graph.groups.find(
      (group) => group.parent !== undefined && !groups.has(group.parent),
    ) ??
    graph.edges.find((edge) => !nodes.has(edge.from) || !nodes.has(edge.to));
  if (missing !== undefined) return `${missing.key} names a missing key`;

  for (const group of graph.groups) {
    let at = group.parent;
    for (let step = 0; at !== undefined; step += 1) {
      if (at === group.key || step > graph.groups.length) {
        return `the group ${group.key} is in a parent loop`;
      }
      at = groups.get(at)?.parent;
    }
  }
  if (graph.algorithm === 'mrtree') return treeProblemOf(graph);
  const ends = graph.edges.some(
    (edge) => edge.tailLabel !== undefined || edge.headLabel !== undefined,
  );
  return ends && graph.groups.length > 0 ? 'end labels with groups' : undefined;
};

/** The options F18 adds for markers on edge ends: every end segment longer than the longest marker. */
const MARKER_OPTIONS: LayoutOptions = {
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.spacing.nodeNodeBetweenLayers': '48',
  'elk.spacing.nodeSelfLoop': '20',
  'elk.spacing.edgeLabel': '8',
};

/** An edge's labels as ELK takes them: id `<key>:c`, `:t`, `:h`, placed at the centre, tail and head. */
const labelsOf = (
  edge: LayoutGraph['edges'][number],
): NonNullable<ElkExtendedEdge['labels']> =>
  (
    [
      ['c', 'CENTER', edge.label],
      ['t', 'TAIL', edge.tailLabel],
      ['h', 'HEAD', edge.headLabel],
    ] as const
  ).flatMap(([suffix, placement, size]) =>
    size === undefined
      ? []
      : [
          {
            id: `${edge.key}:${suffix}`,
            // ELK places only a label with text; the key stands in for it.
            text: edge.key,
            width: size.width,
            height: size.height,
            layoutOptions: { 'elk.edgeLabels.placement': placement },
          },
        ],
  );

/** The ELK graph of `graph`: groups hold their child groups and nodes; every edge is on the root. */
const elkGraphOf = (graph: LayoutGraph): ElkNode => {
  const { top, side } = graph.groupPadding;
  const childrenOf = (parent: string | undefined): ElkNode[] => [
    ...graph.groups
      .filter((group) => group.parent === parent)
      .map(
        (group): ElkNode => ({
          id: group.key,
          layoutOptions: {
            'elk.padding': `[top=${top},left=${side},bottom=${side},right=${side}]`,
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            // ELK applies a compound node's minimum in its direction-relative
            // frame, so the pair is swapped for `down` (F6, FT5).
            'elk.nodeSize.minimum':
              graph.direction === 'down'
                ? `(${GROUP_MIN_DEPTH}, ${group.minWidth})`
                : `(${group.minWidth}, ${GROUP_MIN_DEPTH})`,
          },
          children: childrenOf(group.key),
        }),
      ),
    ...graph.nodes
      .filter((node) => node.group === parent)
      .map(
        (node): ElkNode => ({
          id: node.key,
          width: node.width,
          height: node.height,
        }),
      ),
  ];
  const direction = graph.direction === 'down' ? 'DOWN' : 'RIGHT';
  const layoutOptions: LayoutOptions =
    graph.algorithm === 'mrtree'
      ? {
          'elk.algorithm': 'mrtree',
          'elk.direction': direction,
          'elk.spacing.nodeNode': '16',
          'elk.randomSeed': '1',
          'elk.json.shapeCoords': 'ROOT',
          'elk.json.edgeCoords': 'ROOT',
        }
      : {
          'elk.algorithm': 'layered',
          'elk.direction': direction,
          'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
          'elk.edgeRouting': 'ORTHOGONAL',
          'elk.randomSeed': '1',
          'elk.json.shapeCoords': 'ROOT',
          'elk.json.edgeCoords': 'ROOT',
          ...(graph.markerSpacing === true ? MARKER_OPTIONS : {}),
        };
  return {
    id: 'root',
    layoutOptions,
    children: childrenOf(undefined),
    edges: graph.edges.map((edge): ElkExtendedEdge => {
      const labels = labelsOf(edge);
      return {
        id: edge.key,
        sources: [edge.from],
        targets: [edge.to],
        ...(labels.length === 0 ? {} : { labels }),
      };
    }),
  };
};

const boxOf = (shape: {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}): Box => ({
  x: shape.x ?? 0,
  y: shape.y ?? 0,
  width: shape.width ?? 0,
  height: shape.height ?? 0,
});

/** The points of an edge's sections: start, bends, end, with no two equal in a row. */
const pointsOf = (edge: ElkExtendedEdge): Point[] =>
  (edge.sections ?? [])
    .flatMap((section) => [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ])
    .map(({ x, y }) => ({ x, y }))
    .filter(
      (point, i, all) =>
        i === 0 || point.x !== all[i - 1]?.x || point.y !== all[i - 1]?.y,
    );

/** Copies the laid-out ELK graph into a result keyed by the graph's keys; ELK's own fields are left behind. */
const resultOf = (graph: LayoutGraph, laidOut: ElkNode): LayoutResult => {
  const groupKeys = new Set(graph.groups.map((group) => group.key));
  const nodes: Record<string, Box> = {};
  const groups: Record<string, Box> = {};
  const edges: Record<
    string,
    { points: Point[]; label?: Box; tailLabel?: Box; headLabel?: Box }
  > = {};

  const visit = (node: ElkNode): void => {
    for (const child of node.children ?? []) {
      (groupKeys.has(child.id) ? groups : nodes)[child.id] = boxOf(child);
      visit(child);
    }
    for (const edge of node.edges ?? []) {
      const labelBox = (suffix: string) => {
        const label = edge.labels?.find(
          ({ id }) => id === `${edge.id}:${suffix}`,
        );
        return label === undefined ? undefined : boxOf(label);
      };
      const [label, tailLabel, headLabel] = ['c', 't', 'h'].map(labelBox);
      edges[edge.id] = {
        points: pointsOf(edge),
        ...(label === undefined ? {} : { label }),
        ...(tailLabel === undefined ? {} : { tailLabel }),
        ...(headLabel === undefined ? {} : { headLabel }),
      };
    }
  };
  visit(laidOut);

  return {
    width: laidOut.width ?? 0,
    height: laidOut.height ?? 0,
    nodes,
    groups,
    edges,
  };
};

const swapSize = <
  T extends { readonly width: number; readonly height: number },
>(
  size: T,
): T => ({ ...size, width: size.height, height: size.width });
const swapBox = (box: Box): Box => ({
  x: box.y,
  y: box.x,
  width: box.height,
  height: box.width,
});
const swapOptional = (box: Box | undefined) =>
  box === undefined ? undefined : swapBox(box);

/** `graph` with every width and height swapped, laid out `down` (F18's transposed layout). */
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

/** `result` with x and y, width and height swapped in every box and point. */
const transposed = (result: LayoutResult): LayoutResult => {
  const boxes = (record: Readonly<Record<string, Box>>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, box]) => [key, swapBox(box)]),
    );
  return {
    width: result.height,
    height: result.width,
    nodes: boxes(result.nodes),
    groups: boxes(result.groups),
    edges: Object.fromEntries(
      Object.entries(result.edges).map(([key, edge]) => {
        const label = swapOptional(edge.label);
        const tailLabel = swapOptional(edge.tailLabel);
        const headLabel = swapOptional(edge.headLabel);
        return [
          key,
          {
            points: edge.points.map(({ x, y }) => ({ x: y, y: x })),
            ...(label === undefined ? {} : { label }),
            ...(tailLabel === undefined ? {} : { tailLabel }),
            ...(headLabel === undefined ? {} : { headLabel }),
          },
        ];
      }),
    ),
  };
};

/**
 * Lays `graph` out with ELK: `layered` (F6 options, plus F18's marker options with
 * `markerSpacing`; group padding from `graph.groupPadding`) or `mrtree` (`graph.algorithm`;
 * F18's options). A `right` graph with `transposeRight` is laid out `DOWN` with widths and
 * heights swapped, and every box and point of the result swapped back. End labels are placed
 * at `TAIL`/`HEAD` and read back by id. One ELK instance per window, made at the first call.
 * Same graph, same result. Rejects, before ELK runs, with
 * `Error('Invalid layout graph: <first problem>')` for a repeated key, a missing key reference,
 * a group-parent loop, `the graph is not a tree` (`mrtree` with a group, a node with two
 * incoming edges, or an edge loop), `layered options on an mrtree graph` (`mrtree` with an end
 * label, `markerSpacing` or `transposeRight`), or `end labels with groups`; with ELK's error
 * when ELK throws. Imports no relative module by value.
 */
export const layout = async (graph: LayoutGraph): Promise<LayoutResult> => {
  const problem = problemOf(graph);
  if (problem !== undefined) {
    throw new Error(`Invalid layout graph: ${problem}`);
  }
  elk ??= new ElkConstructor();
  if (graph.direction === 'right' && graph.transposeRight === true) {
    const down = swappedDown(graph);
    return transposed(resultOf(down, await elk.layout(elkGraphOf(down))));
  }
  return resultOf(graph, await elk.layout(elkGraphOf(graph)));
};
