// `scene-hit.ts` — what lies under the canvas's pointer, as the preview says
// it: the canvas (`desktop/ui/canvas`) asks, and the preview answers over its
// derived tree. The target is the frame's node when it named one, else the
// derived tree's cached bounds under the viewport's transform (never
// `document.elementFromPoint`, which a transformed canvas breaks). A comment's
// anchor is the element the target names, or a free point with the nearest
// element.

import type { CanvasHitTester, CanvasPointerAt } from 'desktop/ui/canvas';

import type { CommentAnchor } from '../../contracts/index.js';
import { anchorOf, pointAnchorOf } from '../anchor.js';
import { anchorIndexOf, offsetIn } from './pin-geometry.js';
import type { Scene } from './scene.js';
import {
  hitTest,
  nearestNode,
  type PseudoKind,
  pseudoAt,
  type SceneNode,
  type SceneTarget,
  targetBounds,
  targetById,
  targetIdOf,
} from './scene-graph.js';

/** A frame-reported pseudo-element, when it is one the scene knows. */
const pseudoKindOf = (pseudo: string | undefined): PseudoKind | undefined =>
  pseudo === '::before' || pseudo === '::after' ? pseudo : undefined;

/**
 * The node under the pointer: the one the frame resolved the event to, else
 * the hit-test under the transform, else (when `nearest`) the nearest node.
 */
const hostOf = (
  scene: Scene,
  hidden: ReadonlySet<string>,
  pointer: CanvasPointerAt,
  nearest: boolean,
): SceneNode | undefined => {
  const named =
    pointer.nodeId === undefined
      ? undefined
      : scene.graph.byId.get(pointer.nodeId);

  if (named !== undefined) return named;

  return (
    hitTest(scene.graph, pointer.content, scene.bounds, hidden) ??
    (nearest
      ? nearestNode(scene.graph, pointer.content, scene.bounds, hidden)
      : undefined)
  );
};

/**
 * The target under the pointer: its node, or the node's out-of-flow
 * `::before` / `::after` when the pointer lies on its box (as the frame says,
 * else as the scene's pseudo boxes do).
 */
const targetOf = (
  scene: Scene,
  hidden: ReadonlySet<string>,
  pointer: CanvasPointerAt,
  nearest: boolean,
): SceneTarget | undefined => {
  const node = hostOf(scene, hidden, pointer, nearest);

  if (node === undefined) return undefined;

  const pseudo =
    (pointer.nodeId === node.id ? pseudoKindOf(pointer.pseudo) : undefined) ??
    pseudoAt(node, pointer.content, scene.pseudoBounds);

  return { node, pseudo };
};

/**
 * The target under the pointer, never the document's own body: empty space
 * points at nothing.
 */
const pointedTargetOf = (
  scene: Scene,
  hidden: ReadonlySet<string>,
  pointer: CanvasPointerAt,
): SceneTarget | undefined => {
  const target = targetOf(scene, hidden, pointer, false);

  return target === undefined ||
    target.node.tag === 'body' ||
    target.node.tag === 'html'
    ? undefined
    : target;
};

/**
 * The canvas's hit-test over the preview's derived tree, skipping `hidden`
 * nodes. Target ids are `targetIdOf` ids (`n4`, `n4::before`).
 * `targetAt(p, 'select')`: the node the frame named, else the hit-test, else
 * the nearest node, with its pseudo-element when the pointer lies on it.
 * `targetAt(p, 'point')`: no nearest fallback, and never `body` or `html`.
 * A frame-reported `pseudo` counts only for the node it came with and only as
 * `::before`/`::after`. `anchorAt(p, id)`: the element anchor of the target `id`
 * names (offset, index and pseudo included); without `id`, or when it names
 * nothing in the scene, a free point anchor with the nearest node. With
 * `scene` undefined, `targetAt` answers undefined and `anchorAt` still answers
 * a free point anchor with no nearest node.
 */
export const sceneHitTester = (
  scene: Scene | undefined,
  hidden: ReadonlySet<string>,
): CanvasHitTester<CommentAnchor> => ({
  targetAt: (pointer, mode) => {
    if (scene === undefined) return undefined;

    const target =
      mode === 'select'
        ? targetOf(scene, hidden, pointer, true)
        : pointedTargetOf(scene, hidden, pointer);

    return target === undefined ? undefined : targetIdOf(target);
  },
  anchorAt: (pointer, targetId) => {
    const point = pointer.content;
    const target =
      scene === undefined || targetId === undefined
        ? undefined
        : targetById(scene.graph, targetId);

    if (scene === undefined || target === undefined) {
      return pointAnchorOf(
        point,
        scene === undefined
          ? undefined
          : nearestNode(scene.graph, point, scene.bounds, hidden),
      );
    }

    return anchorOf(
      target.node,
      offsetIn(targetBounds(target, scene.bounds, scene.pseudoBounds), point),
      point,
      anchorIndexOf(scene.graph, target.node),
      target.pseudo,
    );
  },
});
