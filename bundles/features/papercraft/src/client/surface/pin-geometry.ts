// `pin-geometry.ts` — where a comment's pin sits on the rendered preview.
//
// An element anchor records where inside its element the click landed, as
// fractions of the element's box (`offset`), so the pin follows the element
// through layout changes and any pan/zoom; a free point keeps its content
// coordinates. The anchor's forms and meaning are unchanged — the offset is an
// extra key the agent may ignore.
//
// A later revision re-renders the file the agent edited: the anchor's
// selector is the identity. An anchor re-resolves to an element of its own
// selector — the one with the recorded text excerpt, the recorded ordinal
// (`index`, an extra key), the only one, the one under the recorded point,
// else the first — and never to an element of another selector.

import type { CommentAnchor } from '../../contracts/index.js';
import {
  type AnchorOffset,
  excerptOf,
  indexOf,
  offsetOf,
  pseudoOf,
} from '../anchor.js';
import {
  type Bounds,
  type BoundsOf,
  nodeLabel,
  type PseudoBoundsOf,
  type SceneGraph,
  type SceneNode,
  targetBounds,
} from './scene-graph.js';

/** A point in content coordinates. */
export interface ContentPoint {
  readonly x: number;
  readonly y: number;
}

/** The elements of a selector, in document order: an anchor's `index` counts among these. */
const peersOf = (graph: SceneGraph, selector: string): readonly SceneNode[] =>
  graph.nodes.filter((node) => nodeLabel(node) === selector);

/**
 * The ordinal a comment records for the element it is written on: its place
 * among the elements of its selector, in document order.
 */
export const anchorIndexOf = (
  graph: SceneGraph,
  node: SceneNode,
): number | undefined => {
  const index = peersOf(graph, nodeLabel(node)).indexOf(node);

  return index < 0 ? undefined : index;
};

const distanceTo = (box: Bounds, point: ContentPoint): number => {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));

  return Math.hypot(dx, dy);
};

/** The candidate under `point` (the smallest when nested), else the nearest. */
const nearestTo = (
  candidates: readonly SceneNode[],
  point: ContentPoint,
  bounds: BoundsOf,
): SceneNode | undefined => {
  let best: SceneNode | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestArea = Number.POSITIVE_INFINITY;

  for (const node of candidates) {
    const box = bounds(node);
    const distance = distanceTo(box, point);
    const area = box.width * box.height;

    if (
      distance < bestDistance ||
      (distance === bestDistance && area < bestArea)
    ) {
      best = node;
      bestDistance = distance;
      bestArea = area;
    }
  }

  return best;
};

/** Which of the peers of its selector the anchor means. */
const pickPeer = (
  peers: readonly SceneNode[],
  anchor: CommentAnchor,
  bounds: BoundsOf | undefined,
): SceneNode | undefined => {
  if (peers.length === 0) return undefined;

  const text = excerptOf(anchor.text ?? '');
  const quoted =
    text === ''
      ? []
      : peers.filter((node) => excerptOf(node.text).startsWith(text));

  if (quoted.length === 1) return quoted[0];

  // Several share the text, or the agent changed it: the ordinal decides.
  const pool = quoted.length > 0 ? quoted : peers;
  const index = indexOf(anchor);
  const ordinal = index === undefined ? undefined : peers[index];

  if (ordinal !== undefined && pool.includes(ordinal)) return ordinal;
  if (pool.length === 1) return pool[0];

  if (
    bounds !== undefined &&
    typeof anchor.x === 'number' &&
    typeof anchor.y === 'number'
  )
    return nearestTo(pool, { x: anchor.x, y: anchor.y }, bounds);

  return pool[0];
};

/**
 * The node an anchor names, if the derivation still has one of its selector.
 * `bounds` lets an anchor that recorded only its point pick the element of
 * its selector under that point.
 */
export const nodeOfAnchor = (
  graph: SceneGraph,
  anchor: CommentAnchor,
  bounds?: BoundsOf,
): SceneNode | undefined => {
  if (anchor.selector === undefined) return undefined;

  // A program's selector anchor names a statement (D19): the first node of
  // that statement's wrapper.
  const statement = graph.nodes.find(
    (node) => node.statement === anchor.selector,
  );

  if (statement !== undefined) return statement;

  return pickPeer(peersOf(graph, anchor.selector), anchor, bounds);
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Where a content point sits inside a box, as fractions of it. */
export const offsetIn = (box: Bounds, point: ContentPoint): AnchorOffset => ({
  x: box.width > 0 ? clamp01((point.x - box.x) / box.width) : 0,
  y: box.height > 0 ? clamp01((point.y - box.y) / box.height) : 0,
});

/**
 * The content point of an anchor's pin: inside its element at the recorded
 * offset (the element's corner without one), else the point the anchor
 * recorded — a free point's own, or where an element's comment was clicked
 * when the revision on screen no longer has that element — else `fallback`.
 *
 * When the anchor names a valid `pseudo` (`pseudoOf`) and `pseudoBounds`
 * gives that pseudo-element of the resolved node a box, the box the offset
 * applies to is that pseudo box. Otherwise it is the host's `bounds(node)`.
 * The node is resolved exactly as before (`nodeOfAnchor`), so `pseudo` never
 * changes which element an anchor means.
 */
export const pinPointOf = (
  anchor: CommentAnchor,
  graph: SceneGraph | undefined,
  bounds: BoundsOf | undefined,
  fallback?: ContentPoint,
  pseudoBounds?: PseudoBoundsOf,
): ContentPoint | undefined => {
  const node =
    anchor.form === 'point' || graph === undefined
      ? undefined
      : nodeOfAnchor(graph, anchor, bounds);

  if (node !== undefined && bounds !== undefined) {
    const box = targetBounds(
      { node, pseudo: pseudoOf(anchor) },
      bounds,
      pseudoBounds,
    );
    const offset = offsetOf(anchor);

    return offset === undefined
      ? { x: box.x, y: box.y }
      : { x: box.x + offset.x * box.width, y: box.y + offset.y * box.height };
  }

  if (typeof anchor.x === 'number' && typeof anchor.y === 'number')
    return { x: anchor.x, y: anchor.y };

  return fallback;
};

/**
 * `pinPointOf` over one derivation, resolving each anchor once. The pins
 * are laid again on every zoom and every reading of the threads and drafts,
 * and an anchor's element does not move between two readings of the same
 * derivation — only a new derivation, or new bounds, measure again.
 * `pseudoBounds` places an anchor on a pseudo-element as `pinPointOf` does.
 */
export const anchorResolver = (
  graph: SceneGraph | undefined,
  bounds: BoundsOf | undefined,
  pseudoBounds?: PseudoBoundsOf,
): ((
  anchor: CommentAnchor,
  fallback?: ContentPoint,
) => ContentPoint | undefined) => {
  const resolved = new Map<CommentAnchor, ContentPoint | undefined>();

  return (anchor, fallback) => {
    if (!resolved.has(anchor)) {
      resolved.set(
        anchor,
        pinPointOf(anchor, graph, bounds, undefined, pseudoBounds),
      );
    }

    return resolved.get(anchor) ?? fallback;
  };
};
