// `scene.ts` — the canvas's reading of what the revision rendered: the
// derived tree (`scene-graph.ts`) and the bounds of its nodes, in content
// coordinates, together as one value.
//
// The revision renders in its own frame (`live-frame.tsx`), which derives the
// tree from its DOM and sends it as a `scene` message: each node with its
// border box cut to what its clipping ancestors leave visible, and its
// out-of-flow `::before` / `::after` boxes, all in CSS pixels of the frame's
// document. The iframe sits at the content origin and the canvas scales it
// with its `transform`, so those pixels are already content coordinates: the
// zoom never enters a measure. The artifact's layout depends on the canvas's
// width, so the canvas asks the frame for a fresh scene (`measure`) when it
// changes size, and the frame sends one whenever what it renders changes.

import { useCallback, useState } from 'react';

import type { SceneNodeData } from '../frame-protocol.js';
import {
  type Bounds,
  type BoundsOf,
  type PseudoBoundsOf,
  type SceneGraph,
  sceneGraphOf,
} from './scene-graph.js';

/** One derivation of the rendered revision, with its measured bounds. */
export interface Scene {
  readonly graph: SceneGraph;
  /**
   * The node bounds in content coordinates: the element's own border box
   * only, cut to what its clipping ancestors leave visible. A pseudo-element
   * never widens its host's box. An unknown node measures empty.
   */
  readonly bounds: BoundsOf;
  /**
   * The out-of-flow `::before` / `::after` boxes, in the same content
   * coordinates as `bounds`. Undefined when the frame measured no such box
   * (in flow, no content, an `auto` inset) or the box has no area.
   */
  readonly pseudoBounds: PseudoBoundsOf;
  /** The nodes as the frame sent them, kept to render the scene again. */
  readonly data: readonly SceneNodeData[];
}

const EMPTY: Bounds = { x: 0, y: 0, width: 0, height: 0 };

const hasArea = (bounds: Bounds): boolean =>
  bounds.width > 0 || bounds.height > 0;

/** The scene of one `scene` message's nodes. */
export const sceneOf = (data: readonly SceneNodeData[]): Scene => {
  const graph = sceneGraphOf(data);
  const boxes = new Map<string, Bounds>();
  const pseudos = new Map<string, NonNullable<SceneNodeData['pseudo']>>();

  // Only the first node of an id made the graph: its boxes are the ones read.
  for (const node of data) {
    if (boxes.has(node.id)) continue;

    boxes.set(node.id, node.bounds);
    if (node.pseudo !== undefined) pseudos.set(node.id, node.pseudo);
  }

  return {
    graph,
    data,
    bounds: (node) => boxes.get(node.id) ?? EMPTY,
    pseudoBounds: (node, pseudo) => {
      const box = pseudos.get(node.id)?.[pseudo];

      return box !== undefined && hasArea(box) ? box : undefined;
    },
  };
};

/**
 * The canvas's scene: built from each `scene` message the surface hands on
 * (`onScene`), dropped when the surface goes (`onScene(undefined)`).
 */
export const useScene = (): {
  readonly scene: Scene | undefined;
  readonly onScene: (nodes: readonly SceneNodeData[] | undefined) => void;
} => {
  const [scene, setScene] = useState<Scene | undefined>(undefined);

  const onScene = useCallback((nodes: readonly SceneNodeData[] | undefined) => {
    setScene(nodes === undefined ? undefined : sceneOf(nodes));
  }, []);

  return { scene, onScene };
};
