// The canvas's scene (`scene.ts`): what a `scene` message of the preview's
// frame says, as the canvas reads it. Each node's bounds are its own border
// box in content coordinates (the frame's CSS pixels: the iframe sits at the
// content origin under the viewport's transform, so no zoom enters them);
// each out-of-flow `::before` / `::after` box is its own target
// (`pseudoBounds`), so a point on it answers the pseudo, and an offset is
// measured in its box. How the frame measures those boxes is the runtime's
// (`frames/preview`), not the canvas's.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SceneNodeData } from '../../src/client/frame-protocol.js';
import { offsetIn } from '../../src/client/surface/pin-geometry.js';
import { sceneOf } from '../../src/client/surface/scene.js';
import {
  hitTest,
  pseudoAt,
  type SceneNode,
  targetBounds,
} from '../../src/client/surface/scene-graph.js';

const node = (
  id: string,
  bounds: SceneNodeData['bounds'],
  extra: Partial<SceneNodeData> = {},
): SceneNodeData => ({
  id,
  depth: 0,
  tag: 'div',
  classes: [],
  text: '',
  bounds,
  ...extra,
});

/** A 100×40 host with an `::after` strip 4px tall right below it. */
const HOST = { x: 0, y: 0, width: 100, height: 40 };
const STRIP = { x: 0, y: 40, width: 100, height: 4 };

const strip = () => {
  const scene = sceneOf([
    node('n0', HOST, { elementId: 'host', pseudo: { '::after': STRIP } }),
  ]);
  const host = scene.graph.byId.get('n0') as SceneNode;

  return { scene, host };
};

test('a host keeps its own box and its out-of-flow pseudo-element its own', () => {
  const { scene, host } = strip();

  assert.deepEqual(scene.bounds(host), HOST);
  assert.deepEqual(scene.pseudoBounds(host, '::after'), STRIP);
  assert.equal(scene.pseudoBounds(host, '::before'), undefined);
});

test('the bounds are content coordinates as the frame measured them, at any zoom', () => {
  // A node the frame measured at (20, 10) is there whatever the canvas's
  // scale: the frame never sees the zoom.
  const scene = sceneOf([node('n0', { x: 20, y: 10, width: 100, height: 40 })]);
  const only = scene.graph.byId.get('n0') as SceneNode;

  assert.deepEqual(scene.bounds(only), {
    x: 20,
    y: 10,
    width: 100,
    height: 40,
  });
});

test('an empty host drawn only by its pseudo-element keeps its empty box', () => {
  const scene = sceneOf([
    node(
      'n0',
      { x: 30, y: 30, width: 0, height: 0 },
      { pseudo: { '::before': { x: 30, y: 30, width: 20, height: 20 } } },
    ),
  ]);
  const host = scene.graph.byId.get('n0') as SceneNode;

  assert.deepEqual(scene.bounds(host), { x: 30, y: 30, width: 0, height: 0 });
  assert.deepEqual(scene.pseudoBounds(host, '::before'), {
    x: 30,
    y: 30,
    width: 20,
    height: 20,
  });
});

test('a pseudo-element box with no area is no target', () => {
  const scene = sceneOf([
    node('n0', HOST, {
      pseudo: { '::after': { x: 0, y: 40, width: 0, height: 0 } },
    }),
  ]);
  const host = scene.graph.byId.get('n0') as SceneNode;

  assert.equal(scene.pseudoBounds(host, '::after'), undefined);
});

test('a node the scene does not know measures empty', () => {
  const { scene } = strip();
  const stranger = { ...(scene.graph.nodes[0] as SceneNode), id: 'n9' };

  assert.deepEqual(scene.bounds(stranger), {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  assert.equal(scene.pseudoBounds(stranger, '::after'), undefined);
});

test('a point on the pseudo-element answers the pseudo, at an offset in its box', () => {
  const { scene, host } = strip();
  const onStrip = { x: 50, y: 42 };
  const onHost = { x: 50, y: 20 };

  assert.equal(pseudoAt(host, onStrip, scene.pseudoBounds), '::after');
  assert.equal(pseudoAt(host, onHost, scene.pseudoBounds), undefined);
  assert.equal(hitTest(scene.graph, onHost, scene.bounds)?.id, host.id);
  assert.deepEqual(
    offsetIn(
      targetBounds(
        { node: host, pseudo: '::after' },
        scene.bounds,
        scene.pseudoBounds,
      ),
      onStrip,
    ),
    { x: 0.5, y: 0.5 },
  );
});

test('where ::before and ::after share a box, the point answers ::after', () => {
  const scene = sceneOf([
    node('n0', HOST, { pseudo: { '::before': STRIP, '::after': STRIP } }),
  ]);

  assert.equal(
    pseudoAt(
      scene.graph.byId.get('n0') as SceneNode,
      { x: 50, y: 42 },
      scene.pseudoBounds,
    ),
    '::after',
  );
});
