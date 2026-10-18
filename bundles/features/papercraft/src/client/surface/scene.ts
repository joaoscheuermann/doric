// `scene.ts` — the frame's reading of what the revision rendered: the
// derived tree (`scene-graph.ts`) and the bounds of its nodes, measured in
// content coordinates, together as one value the frame re-derives when the
// surface reports its content and re-measures when the canvas changes size.
//
// The artifact's layout depends on the canvas's width (a page, or a
// `padded` or `fullscreen` story, is as wide as the canvas, and a centred
// one wraps at it), so a bounds cache is only good for the size it was
// measured at: a resize keeps the graph and measures again. Hidden layers are view
// state applied to the artifact's DOM — a node in `hidden` never answers a
// pointer — and a new derivation re-applies them to the elements it found.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type Bounds,
  type BoundsOf,
  boundsIndex,
  buildSceneGraph,
  type Clip,
  clipBounds,
  type SceneGraph,
} from './scene-graph.js';

/** One derivation of the rendered revision, with its measured bounds. */
export interface Scene {
  readonly graph: SceneGraph;
  /** The node bounds in content coordinates, measured once per node. */
  readonly bounds: BoundsOf;
  /** The content element the bounds are measured from; the root when absent. */
  readonly content: HTMLElement | null;
}

const boxOf = (element: Element): Bounds => {
  const rect = element.getBoundingClientRect();

  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
};

/**
 * The ancestors that clip an element, up to the content: those that hide
 * their overflow on some axis and lie on its containing-block chain. An
 * absolutely positioned box escapes the static ancestors below its
 * containing block, and a fixed one every ancestor up to the content (its
 * containing block, by `contain: layout`).
 */
const clipsOf = (
  element: Element,
  stop: Element | null,
  styleOf: (element: Element) => CSSStyleDeclaration,
): Clip[] => {
  const clips: Clip[] = [];
  let position = styleOf(element).position;

  for (
    let ancestor = element.parentElement;
    ancestor !== null && ancestor !== stop;
    ancestor = ancestor.parentElement
  ) {
    const style = styleOf(ancestor);

    if (position === 'fixed') continue;
    if (position === 'absolute' && style.position === 'static') continue;

    const x = style.overflowX !== 'visible';
    const y = style.overflowY !== 'visible';

    if (x || y) clips.push({ box: boxOf(ancestor), x, y });

    position = style.position;
  }

  return clips;
};

/**
 * A fresh, lazy cache of node bounds in content coordinates: the part of
 * each node its clipping ancestors leave visible (`clipBounds`). Each node is
 * measured on its first reading, at the scale the canvas has then — its rect,
 * its clips and the divisor are read together, so a zoom between two
 * readings changes nothing.
 */
const measured = (
  content: HTMLElement | null,
  scale: () => number,
): BoundsOf => {
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element): CSSStyleDeclaration => {
    let style = styles.get(element);

    if (style === undefined) {
      // The element's own window: a frame without one clips nothing.
      style =
        element.ownerDocument.defaultView?.getComputedStyle(element) ??
        ({
          position: 'static',
          overflowX: 'visible',
          overflowY: 'visible',
        } as CSSStyleDeclaration);
      styles.set(element, style);
    }

    return style;
  };

  return boundsIndex((node) => {
    const shown = clipBounds(
      boxOf(node.element),
      clipsOf(node.element, content, styleOf),
    );
    const origin = content?.getBoundingClientRect() ?? { x: 0, y: 0 };
    const factor = scale();

    return {
      x: (shown.x - origin.x) / factor,
      y: (shown.y - origin.y) / factor,
      width: shown.width / factor,
      height: shown.height / factor,
    };
  });
};

/** The scene of what a shadow root holds now. */
export const sceneOf = (root: ShadowRoot, scale: () => number): Scene => {
  const content = root.querySelector(
    '.papercraft-content',
  ) as HTMLElement | null;

  return {
    graph: buildSceneGraph(content ?? root),
    content,
    bounds: measured(content, scale),
  };
};

/** The same derivation, measured again. */
export const remeasured = (scene: Scene, scale: () => number): Scene => ({
  ...scene,
  bounds: measured(scene.content, scale),
});

/**
 * The frame's scene: derived from each content report of the surface
 * (`onContent`), re-measured on demand (`remeasure`, which answers the new
 * scene at once so a fit can use it before the render).
 */
export const useScene = (
  scale: () => number,
): {
  readonly scene: Scene | undefined;
  readonly onContent: (root: ShadowRoot | undefined) => void;
  readonly remeasure: () => Scene | undefined;
} => {
  const [scene, setScene] = useState<Scene | undefined>(undefined);
  const current = useRef(scene);
  current.current = scene;

  const onContent = useCallback(
    (root: ShadowRoot | undefined) => {
      setScene(root === undefined ? undefined : sceneOf(root, scale));
    },
    [scale],
  );

  const remeasure = useCallback((): Scene | undefined => {
    const known = current.current;

    if (known === undefined) return undefined;

    const next = remeasured(known, scale);
    current.current = next;
    setScene(next);

    return next;
  }, [scale]);

  return { scene, onContent, remeasure };
};

/**
 * Applies the hidden layers to the artifact's DOM: the nodes in `hidden` are
 * invisible, every other derived node visible. A derivation with nothing
 * hidden, after one with nothing hidden, touches no element.
 */
export const useHiddenLayers = (
  scene: Scene | undefined,
  hidden: ReadonlySet<string>,
): void => {
  const layered = useRef(false);

  useEffect(() => {
    if (hidden.size === 0 && !layered.current) return;

    for (const node of scene?.graph.nodes ?? []) {
      (node.element as HTMLElement).style.visibility = hidden.has(node.id)
        ? 'hidden'
        : '';
    }

    layered.current = hidden.size > 0;
  }, [scene, hidden]);
};
