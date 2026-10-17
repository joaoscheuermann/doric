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

  const visit = (parent: ParentNode, depth: number, parentNode?: SceneNode) => {
    for (const child of parent.children) {
      if (nodes.length >= limit) return;
      if (SKIP_TAGS.has(child.tagName)) continue;

      const node: SceneNode = {
        id: `n${nodes.length}`,
        tag: child.tagName.toLowerCase(),
        classes: (child.getAttribute('class') ?? '')
          .trim()
          .split(/\s+/)
          .filter((name) => name !== ''),
        stamp: inheritedStamp(child, parentNode),
        element: child,
        depth,
        ...(parentNode === undefined ? {} : { parentId: parentNode.id }),
      };

      nodes.push(node);
      byId.set(node.id, node);

      const siblings = childrenOf.get(parentNode?.id) ?? [];
      siblings.push(node);
      childrenOf.set(parentNode?.id, siblings);

      visit(child, depth + 1, node);
    }
  };

  visit(root, 0);

  return { nodes, byId, childrenOf };
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

/** An ancestor that hides its overflow: its box, and the axes it clips on. */
export interface Clip {
  readonly box: Bounds;
  readonly x: boolean;
  readonly y: boolean;
}

/**
 * The part of a box its clipping ancestors leave visible: what scrolled out
 * of a scroll area, or overflows a hidden box, is not shown, so it does not
 * count. A box clipped out of sight keeps its place but takes no room.
 */
export const clipBounds = (bounds: Bounds, clips: readonly Clip[]): Bounds => {
  if (clips.length === 0) return bounds;

  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;

  for (const clip of clips) {
    if (clip.x) {
      left = Math.max(left, clip.box.x);
      right = Math.min(right, clip.box.x + clip.box.width);
    }

    if (clip.y) {
      top = Math.max(top, clip.box.y);
      bottom = Math.min(bottom, clip.box.y + clip.box.height);
    }
  }

  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : { x: bounds.x, y: bounds.y, width: 0, height: 0 };
};

/**
 * Whether a node takes up any room. An element that generates no box
 * (`display: contents`, as the module's own wrappers are, or `display: none`)
 * measures as an empty rect at the window's corner, far from the content: it
 * neither bounds the content nor answers a pointer.
 */
const hasArea = (bounds: Bounds): boolean =>
  bounds.width > 0 || bounds.height > 0;

const contains = (bounds: Bounds, point: { x: number; y: number }): boolean =>
  hasArea(bounds) &&
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

    const bounds = boundsOf(node);
    if (!hasArea(bounds)) continue;

    const nodeDistance = distance(bounds, point);
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

/**
 * The content box around every node's bounds that takes up room, for
 * `⤢ ajustar`; undefined when the derivation has nothing measurable.
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

    if (!hasArea(bounds)) continue;

    x = Math.min(x, bounds.x);
    y = Math.min(y, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }

  return Number.isFinite(x) && Number.isFinite(y)
    ? { x, y, width: right - x, height: bottom - y }
    : undefined;
};

/**
 * The box of what the artifact shows, for centring it: `contentBounds` without
 * the page's own frame — the `body` and every container as wide as the page
 * (a `main` that centres a card across `min-height: 100vh`) — whose box is
 * the page, not the element on it. Falls back to `contentBounds` when only
 * the frame is measurable.
 */
export const visualBounds = (
  graph: SceneGraph,
  boundsOf: BoundsOf,
): Bounds | undefined => {
  const page = graph.nodes.reduce(
    (widest, node) => Math.max(widest, boundsOf(node).width),
    0,
  );
  const shown = graph.nodes.filter((node) => {
    if (node.tag === 'body' || node.tag === 'html') return false;

    const container = (graph.childrenOf.get(node.id) ?? []).length > 0;

    return !(container && boundsOf(node).width >= page * 0.99);
  });

  if (shown.length === 0) return contentBounds(graph, boundsOf);

  return contentBounds({ ...graph, nodes: shown }, boundsOf);
};
