// The derived tree of a mounted preview (spec: `scene-graph.ts`).
//
// The preview is code, not JSON: the agent never authors a structure. When the
// canvas needs to interact — hit-test under pan/zoom, selection, layers, an
// anchor for a comment — it derives the tree from the DOM the revision
// rendered inside the shadow root, as Glide keeps its in-memory scene graph.
// This is local canvas cache, rebuilt on every render: never a contract, never
// an event payload, asking nothing of the agent.
//
// The hit-test never reads `document.elementFromPoint`: a canvas with a
// transform breaks the direct position test. Bounds are measured through an
// injectable `boundsOf` so a caller can cache them and a test can supply
// synthetic geometry (happy-dom measures everything as zero).

import { STAMP_ATTRIBUTE } from '../anchor.js';

/** The origin stamp a stamped element carries, as `path:line`. */
export interface SourceStamp {
  readonly path: string;
  readonly line?: number;
}

/** One derived node of the mounted preview. */
export interface SceneNode {
  /** A stable id within one derivation: `n0`, `n1`, … in document order. */
  readonly id: string;
  readonly tag: string;
  readonly classes: readonly string[];
  readonly stamp?: SourceStamp;
  /** The rendered element, inside the preview's shadow root. */
  readonly element: Element;
  readonly depth: number;
  readonly parentId?: string;
}

export interface SceneGraph {
  /** Every derived node, in document order. */
  readonly nodes: readonly SceneNode[];
  readonly byId: ReadonlyMap<string, SceneNode>;
  readonly childrenOf: ReadonlyMap<string | undefined, readonly SceneNode[]>;
}

const SKIP_TAGS = new Set(['STYLE', 'LINK', 'SCRIPT', 'META', 'TITLE']);

const stampOf = (value: string): SourceStamp => {
  const match = /^(.*?):(\d+)$/.exec(value);
  if (match === null) return { path: value };

  const line = Number(match[2]);

  return Number.isInteger(line) && line > 0
    ? { path: match[1] ?? value, line }
    : { path: value };
};

const stampOfElement = (element: Element): SourceStamp | undefined => {
  const stamp = element.getAttribute(STAMP_ATTRIBUTE);

  return stamp !== null && stamp !== '' ? stampOf(stamp) : undefined;
};

const inheritedStamp = (
  element: Element,
  parent: SceneNode | undefined,
): SourceStamp | undefined => {
  const own = stampOfElement(element);

  if (own !== undefined) return own;
  if (parent === undefined) return undefined;

  // The stamp walks down from the stamped ancestor, so a comment on a child
  // still names the source file it came from.
  return parent.stamp;
};

/**
 * Derives the tree of everything the revision rendered under `root`, bounded
 * by `limit` nodes: the derivation is a cache, not a promise to render every
 * node of an unbounded document.
 */
export const buildSceneGraph = (root: ParentNode, limit = 400): SceneGraph => {
  const nodes: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();
  const childrenOf = new Map<string | undefined, SceneNode[]>();

  const visit = (parent: ParentNode, depth: number, parentNodeId?: string) => {
    for (const child of [...parent.children]) {
      if (nodes.length >= limit) return;
      if (SKIP_TAGS.has(child.tagName)) continue;

      const parent =
        parentNodeId === undefined
          ? undefined
          : (byId.get(parentNodeId) as SceneNode);

      const node: SceneNode = {
        id: `n${nodes.length}`,
        tag: child.tagName.toLowerCase(),
        classes: (child.getAttribute('class') ?? '')
          .trim()
          .split(/\s+/)
          .filter((name) => name !== ''),
        stamp: inheritedStamp(child, parent),
        element: child,
        depth,
        ...(parentNodeId === undefined ? {} : { parentId: parentNodeId }),
      };

      nodes.push(node);
      byId.set(node.id, node);

      const siblings = childrenOf.get(parentNodeId) ?? [];
      siblings.push(node);
      childrenOf.set(parentNodeId, siblings);

      visit(child, depth + 1, node.id);
    }
  };

  visit(root, 0);

  return {
    nodes,
    byId,
    childrenOf: new Map(
      [...childrenOf.entries()].map(([key, value]) => [key, [...value]]),
    ),
  };
};

/** The label a derived node shows in the tree: `tag#id`, `tag.a`, else `tag`. */
export const nodeLabel = (node: SceneNode): string => {
  const id = node.element.getAttribute('id');

  if (id !== null && id !== '') return `${node.tag}#${id}`;

  return node.classes.length === 0
    ? node.tag
    : `${node.tag}.${node.classes.slice(0, 2).join('.')}`;
};

/** The anchor stamp of a node, in the form `Checkout.tsx:42` a comment reads. */
export const stampLabel = (node: SceneNode): string | undefined =>
  node.stamp === undefined
    ? undefined
    : node.stamp.line === undefined
      ? node.stamp.path
      : `${node.stamp.path}:${String(node.stamp.line)}`;

/* Bounds and hit-testing ---------------------------------------------------- */

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BoundsOf = (node: SceneNode) => Bounds;

/**
 * The cached bounds index of one derivation: `boundsOf` runs once per node
 * and the result stays until the derivation is rebuilt.
 */
export const boundsIndex = (measure: BoundsOf): BoundsOf => {
  const cache = new Map<string, Bounds>();

  return (node) => {
    const cached = cache.get(node.id);

    if (cached !== undefined) return cached;

    const bounds = measure(node);
    cache.set(node.id, bounds);

    return bounds;
  };
};

const contains = (bounds: Bounds, point: { x: number; y: number }): boolean =>
  point.x >= bounds.x &&
  point.y >= bounds.y &&
  point.x <= bounds.x + bounds.width &&
  point.y <= bounds.y + bounds.height;

const distance = (bounds: Bounds, point: { x: number; y: number }): number => {
  const dx = Math.max(
    bounds.x - point.x,
    0,
    point.x - (bounds.x + bounds.width),
  );
  const dy = Math.max(
    bounds.y - point.y,
    0,
    point.y - (bounds.y + bounds.height),
  );

  return Math.hypot(dx, dy);
};

/**
 * The deepest node whose cached bounds contain the point, in content
 * coordinates: the element the pointer is over, under any pan/zoom. A node in
 * `hidden` never answers.
 */
export const hitTest = (
  graph: SceneGraph,
  point: { readonly x: number; readonly y: number },
  boundsOf: BoundsOf,
  hidden?: ReadonlySet<string>,
): SceneNode | undefined => {
  for (let index = graph.nodes.length - 1; index >= 0; index -= 1) {
    const node = graph.nodes[index] as SceneNode;

    if (hidden?.has(node.id) === true) continue;
    if (contains(boundsOf(node), point)) return node;
  }

  return undefined;
};

/**
 * The node a click on empty space resolves to: the nearest derived node, so a
 * comment keeps an anchor even when the pointer misses the target. Never a
 * hidden node.
 */
export const nearestNode = (
  graph: SceneGraph,
  point: { readonly x: number; readonly y: number },
  boundsOf: BoundsOf,
  hidden?: ReadonlySet<string>,
): SceneNode | undefined => {
  let best: SceneNode | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const node of graph.nodes) {
    if (hidden?.has(node.id) === true) continue;

    const nodeDistance = distance(boundsOf(node), point);
    if (nodeDistance < bestDistance) {
      best = node;
      bestDistance = nodeDistance;
    }
  }

  return best;
};

/**
 * `Isolar`: the nodes to hide so only the selected node, its ancestors and
 * its descendants stay visible — the close-up reading the tree suggests.
 */
export const isolateHiddenIds = (
  graph: SceneGraph,
  selectedId: string,
): ReadonlySet<string> => {
  const visible = new Set<string>([selectedId]);

  // Ancestors keep the chain to the root.
  let cursor = graph.byId.get(selectedId);
  while (cursor?.parentId !== undefined) {
    visible.add(cursor.parentId);
    cursor = graph.byId.get(cursor.parentId);
  }

  // Descendants keep the selected node's own content.
  const descend = (id: string): void => {
    for (const child of graph.childrenOf.get(id) ?? []) {
      visible.add(child.id);
      descend(child.id);
    }
  };
  descend(selectedId);

  return new Set(
    graph.nodes.filter((node) => !visible.has(node.id)).map((node) => node.id),
  );
};

/** Everything visible again: what `Mostrar tudo` clears. */
export const noHiddenIds = (): ReadonlySet<string> => new Set();

/**
 * The content box around every node's bounds, for `⤢ ajustar`; undefined when
 * the derivation has nothing measurable.
 */
export const contentBounds = (
  graph: SceneGraph,
  boundsOf: BoundsOf,
): Bounds | undefined => {
  let x = Number.POSITIVE_INFINITY;
  let y = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const node of graph.nodes) {
    const bounds = boundsOf(node);

    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }

  return Number.isFinite(x) && Number.isFinite(y)
    ? { x, y, width: right - x, height: bottom - y }
    : undefined;
};

/** The node an anchor's selector addresses, if the derivation still has it. */
export const nodeOfSelector = (
  graph: SceneGraph,
  selector: string,
): SceneNode | undefined => {
  for (const node of graph.nodes) {
    if (nodeLabel(node) === selector) return node;
  }

  return undefined;
};
