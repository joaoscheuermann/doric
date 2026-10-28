// The derived tree of a mounted preview (spec: `scene-graph.ts`).
//
// The preview is code, not JSON: the agent never authors a structure. When the
// canvas needs to interact — hit-test under pan/zoom, selection, layers, an
// anchor for a comment — it uses the tree the preview's frame derived from the
// DOM the revision rendered, as Glide keeps its in-memory scene graph. The
// frame runs in its own sandboxed realm, so the tree reaches the app as data
// (a `scene` message of `frame-protocol.ts`), never as live elements: this is
// local canvas cache, rebuilt on every scene, never a contract or an event
// payload, asking nothing of the agent.
//
// The hit-test never reads `document.elementFromPoint`: a canvas with a
// transform breaks the direct position test, and the app cannot see inside the
// frame anyway. Bounds come through a `boundsOf` so a scene answers from the
// frame's measures and a test can supply synthetic geometry.

import type { SceneNodeData } from '../frame-protocol.js';

/** The origin stamp a stamped element carries, as `path:line`. */
export interface SourceStamp {
  readonly path: string;
  readonly line?: number;
}

/** One derived node of the mounted preview, as the frame serialized it. */
export interface SceneNode {
  /** A stable id within one derivation: `n0`, `n1`, … in document order. */
  readonly id: string;
  readonly tag: string;
  readonly classes: readonly string[];
  /** The element's `id` attribute, when it has one. */
  readonly elementId?: string;
  /** Its own `data-papercraft-source` value, exactly as the element carries it. */
  readonly source?: string;
  /** The stamp that names it: its own, else the nearest stamped ancestor's. */
  readonly stamp?: SourceStamp;
  /** Its text, whitespace collapsed and cut short, as the frame read it. */
  readonly text: string;
  readonly depth: number;
  readonly parentId?: string;
}

export interface SceneGraph {
  /** Every derived node, in document order. */
  readonly nodes: readonly SceneNode[];
  readonly byId: ReadonlyMap<string, SceneNode>;
  readonly childrenOf: ReadonlyMap<string | undefined, readonly SceneNode[]>;
}

/** A stamp value (`path:line`, else a bare path) read as its parts. */
export const stampOf = (value: string): SourceStamp => {
  const match = /^(.*?):(\d+)$/.exec(value);
  if (match === null) return { path: value };

  const line = Number(match[2]);

  return Number.isInteger(line) && line > 0
    ? { path: match[1] ?? value, line }
    : { path: value };
};

/** A node's own stamp, when the element itself carries one. */
export const ownStampOf = (node: SceneNode): SourceStamp | undefined =>
  node.source === undefined ? undefined : stampOf(node.source);

/**
 * The tree of the nodes a frame serialized, in document order. The frame is
 * the Project's code's word, so the tree trusts only what it can check: a
 * repeated id is dropped, a parent must come before its child (else the node
 * hangs from the root), and each depth and inherited stamp is derived here
 * from the parent chain, not read from the message.
 */
export const sceneGraphOf = (data: readonly SceneNodeData[]): SceneGraph => {
  const nodes: SceneNode[] = [];
  const byId = new Map<string, SceneNode>();
  const childrenOf = new Map<string | undefined, SceneNode[]>();

  for (const each of data) {
    if (byId.has(each.id)) continue;

    const parent =
      each.parentId === undefined ? undefined : byId.get(each.parentId);
    const source =
      each.stamp === undefined || each.stamp === '' ? undefined : each.stamp;
    // The stamp walks down from the stamped ancestor, so a comment on a child
    // still names the source file it came from.
    const stamp = source === undefined ? parent?.stamp : stampOf(source);
    const elementId =
      each.elementId === undefined || each.elementId === ''
        ? undefined
        : each.elementId;

    const node: SceneNode = {
      id: each.id,
      tag: each.tag.toLowerCase(),
      classes: each.classes.filter((name) => name !== ''),
      ...(elementId === undefined ? {} : { elementId }),
      ...(source === undefined ? {} : { source }),
      ...(stamp === undefined ? {} : { stamp }),
      text: each.text,
      depth: parent === undefined ? 0 : parent.depth + 1,
      ...(parent === undefined ? {} : { parentId: parent.id }),
    };

    nodes.push(node);
    byId.set(node.id, node);

    const siblings = childrenOf.get(parent?.id) ?? [];
    siblings.push(node);
    childrenOf.set(parent?.id, siblings);
  }

  return { nodes, byId, childrenOf };
};

/** The label a derived node shows in the tree: `tag#id`, `tag.a`, else `tag`. */
export const nodeLabel = (node: SceneNode): string => {
  if (node.elementId !== undefined) return `${node.tag}#${node.elementId}`;

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

/* Targets: a node, or one of its pseudo-elements ---------------------------- */

/** The pseudo-elements that can be their own target: `::before` and `::after`. */
export type PseudoKind = '::before' | '::after';

/**
 * The box of one pseudo-element of a node, in the same content coordinates as
 * `BoundsOf`, cut to what the clipping ancestors (and the host's own overflow)
 * leave visible.
 *
 * Returns undefined when that pseudo-element is not a target: it generates no
 * box (`content` is `none`/`normal`), is in flow (`position` is neither
 * `absolute` nor `fixed`), has an inset or margin that does not resolve to px
 * (`auto`, `display: none`), or has no area after clipping. Never throws. It is
 * stable for one derivation at one scale, like `BoundsOf`.
 */
export type PseudoBoundsOf = (
  node: SceneNode,
  pseudo: PseudoKind,
) => Bounds | undefined;

/**
 * What the pointer, the selection and a comment point at: a derived node, or
 * one of its out-of-flow pseudo-elements. A pseudo-element is never a
 * `SceneNode`: the graph, the layers tree and `isolateHiddenIds` know only the
 * host.
 */
export interface SceneTarget {
  readonly node: SceneNode;
  /** Absent for the node itself. */
  readonly pseudo?: PseudoKind;
}

const PSEUDO_KINDS: readonly PseudoKind[] = ['::before', '::after'];

/**
 * The id of a target within one derivation: the node's id (`n4`), or the
 * node's id followed by the pseudo kind (`n4::after`). Pure.
 * Round-trip: `targetById(graph, targetIdOf(t))` gives `t`'s node and pseudo
 * back for any target whose node is in `graph`.
 */
export const targetIdOf = (target: SceneTarget): string =>
  `${target.node.id}${target.pseudo ?? ''}`;

/**
 * The target an id names in `graph`: `n4` is node `n4`, and `n4::before` /
 * `n4::after` are that node's pseudo-element.
 *
 * Returns undefined when the node is not in `graph`, or the suffix is not
 * exactly `::before` or `::after` (`n4::marker`, `n4::`). It does not check
 * that the pseudo-element draws a box: that is `PseudoBoundsOf`'s job.
 * Never throws.
 */
export const targetById = (
  graph: SceneGraph,
  id: string,
): SceneTarget | undefined => {
  const at = id.indexOf('::');

  if (at === -1) {
    const node = graph.byId.get(id);

    return node === undefined ? undefined : { node };
  }

  const node = graph.byId.get(id.slice(0, at));
  const pseudo = PSEUDO_KINDS.find((kind) => kind === id.slice(at));

  return node === undefined || pseudo === undefined
    ? undefined
    : { node, pseudo };
};

/**
 * The label of a target: `nodeLabel(node)` for the node itself, else
 * `nodeLabel(node)` followed by the pseudo kind — `span.badge::after`,
 * `div#card::before`. Pure.
 */
export const targetLabel = (target: SceneTarget): string =>
  `${nodeLabel(target.node)}${target.pseudo ?? ''}`;

/* Bounds and hit-testing ---------------------------------------------------- */

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type BoundsOf = (node: SceneNode) => Bounds;

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
 * The resolved style fields of a `::before` / `::after` pseudo-element that
 * `pseudoBoxOf` reads — a `getComputedStyle(element, '::before')` result fits.
 * Insets and margins are resolved values in CSS px (`'90px'`, `'-6px'`), or
 * `'auto'` when the pseudo-element is not positioned or generates no box.
 */
export type PseudoStyle = Pick<
  CSSStyleDeclaration,
  | 'content'
  | 'position'
  | 'left'
  | 'top'
  | 'right'
  | 'bottom'
  | 'marginLeft'
  | 'marginTop'
  | 'marginRight'
  | 'marginBottom'
>;

/** A resolved CSS px length as a number; NaN for anything else (`auto`). */
const pxOf = (value: string): number =>
  value.endsWith('px') ? Number(value.slice(0, -2)) : Number.NaN;

/**
 * The border box of an out-of-flow pseudo-element, in the same coordinates
 * as `block` — the viewport box of its containing block's padding box —
 * given `factor`, the viewport px per CSS px (the canvas scale).
 *
 * x = block.x + (left + marginLeft) · factor
 * y = block.y + (top + marginTop) · factor
 * width  = block.width  − (left + right + marginLeft + marginRight) · factor
 * height = block.height − (top + bottom + marginTop + marginBottom) · factor
 *
 * Example: block {x:0, y:0, width:100, height:40}, left 90px, top -6px,
 * right -14px, bottom 30px, margins 0, factor 1 → {x:90, y:-6, width:24, height:16}.
 *
 * Returns undefined when the pseudo-element generates no box (`content` is
 * `none` or `normal`), is in flow (`position` is neither `absolute` nor
 * `fixed`), or any inset or margin does not resolve to a finite px number
 * (`auto`, which is also what a `display: none` pseudo resolves to). Never
 * throws; pure — it reads only its arguments.
 */
export const pseudoBoxOf = (
  style: PseudoStyle,
  block: Bounds,
  factor: number,
): Bounds | undefined => {
  if (style.content === 'none' || style.content === 'normal') return undefined;
  if (style.position !== 'absolute' && style.position !== 'fixed') {
    return undefined;
  }

  const left = pxOf(style.left) + pxOf(style.marginLeft);
  const top = pxOf(style.top) + pxOf(style.marginTop);
  const right = pxOf(style.right) + pxOf(style.marginRight);
  const bottom = pxOf(style.bottom) + pxOf(style.marginBottom);

  if (![left, top, right, bottom].every(Number.isFinite)) return undefined;

  return {
    x: block.x + left * factor,
    y: block.y + top * factor,
    width: block.width - (left + right) * factor,
    height: block.height - (top + bottom) * factor,
  };
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

/**
 * The box to outline, hit-test or pin against for a target. For a pseudo
 * target this is `pseudoBounds(node, pseudo)`. It is `bounds(node)` (the host
 * box) for the node itself, for a pseudo target when `pseudoBounds` is absent,
 * or when `pseudoBounds` returns undefined (the pseudo box is gone in this
 * derivation). Always returns a `Bounds`, which may be empty, as
 * `BoundsOf` may.
 */
export const targetBounds = (
  target: SceneTarget,
  bounds: BoundsOf,
  pseudoBounds?: PseudoBoundsOf,
): Bounds =>
  (target.pseudo === undefined
    ? undefined
    : pseudoBounds?.(target.node, target.pseudo)) ?? bounds(target.node);

/**
 * Which out-of-flow pseudo-element of `node` the content point lies on.
 * `::after` is checked first, since it paints above `::before`. A box counts
 * only when it has area, and its edges are inclusive, as in `hitTest`.
 *
 * Returns undefined when neither pseudo box contains the point, or neither is
 * a target (`pseudoBounds` returns undefined). Pure.
 */
export const pseudoAt = (
  node: SceneNode,
  point: { readonly x: number; readonly y: number },
  pseudoBounds: PseudoBoundsOf,
): PseudoKind | undefined =>
  (['::after', '::before'] as const).find((pseudo) => {
    const box = pseudoBounds(node, pseudo);

    return box !== undefined && contains(box, point);
  });

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
