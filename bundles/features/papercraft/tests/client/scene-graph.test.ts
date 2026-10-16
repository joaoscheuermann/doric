// The derived tree (`scene-graph.ts`): built from the DOM the revision
// rendered, stamps inherited down, and every pointer question answered from
// cached bounds — hit-testing under pan/zoom without `document.elementFromPoint`,
// the nearest node for a click on empty space, isolation and the content box.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Window } from 'happy-dom';

const happy = new Window();
for (const name of ['window', 'document', 'Element', 'Node'] as const) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: happy[name as keyof Window],
    writable: true,
  });
}

import {
  type Bounds,
  boundsIndex,
  buildSceneGraph,
  contentBounds,
  hitTest,
  isolateHiddenIds,
  nearestNode,
  nodeLabel,
  type SceneGraph,
  stampLabel,
} from '../../src/client/surface/scene-graph.js';

const mount = (markup: string): SceneGraph => {
  const root = document.createElement('div');
  root.innerHTML = markup;

  return buildSceneGraph(root);
};

test('the tree derives from the rendered DOM, skipping the chrome', () => {
  const graph = mount(
    '<style>body{}</style><main><h1 id="t">T</h1><p class="a b">x</p></main>',
  );

  assert.deepEqual(
    graph.nodes.map((node) => node.tag),
    ['main', 'h1', 'p'],
  );
  assert.equal(graph.nodes[0]?.parentId, undefined);
  assert.equal(graph.nodes[1]?.parentId, 'n0');
  assert.equal(graph.nodes[2]?.depth, 1);
  assert.deepEqual(graph.nodes[2]?.classes, ['a', 'b']);
  assert.equal(graph.childrenOf.get('n0')?.length, 2);
});

test('the origin stamp walks down from the stamped ancestor', () => {
  const graph = mount(
    '<main data-papercraft-source="src/Checkout.tsx:42"><section><button id="pay">Pagar</button></section></main>',
  );

  const main = graph.nodes[0];
  const button = graph.nodes[2];

  assert.deepEqual(main?.stamp, { path: 'src/Checkout.tsx', line: 42 });
  assert.deepEqual(button?.stamp, { path: 'src/Checkout.tsx', line: 42 });
  assert.equal(stampLabel(button), 'src/Checkout.tsx:42');
  assert.equal(nodeLabel(button as never), 'button#pay');
});

test('the bounds are measured once per node and cached', () => {
  const graph = mount('<main><h1>T</h1></main>');
  let measured = 0;

  const bounds = boundsIndex(() => {
    measured += 1;

    return { x: 0, y: 0, width: 10, height: 10 };
  });

  bounds(graph.nodes[1] as never);
  bounds(graph.nodes[1] as never);

  assert.equal(measured, 1);
});

const boundsOf = (boxes: Record<string, Bounds>) => {
  const empty = { x: 0, y: 0, width: 0, height: 0 };

  return (node: { readonly id: string }): Bounds => boxes[node.id] ?? empty;
};

test('the hit-test answers from bounds, not from the document, under zoom', () => {
  const graph = mount(
    '<main><h1 id="t">T</h1><button id="pay">P</button></main>',
  );

  const bounds = boundsOf({
    n0: { x: 0, y: 0, width: 100, height: 40 },
    n1: { x: 200, y: 0, width: 40, height: 40 },
    n2: { x: 300, y: 300, width: 40, height: 40 },
  });

  // A surface point under any pan/zoom resolves to a content point, and the
  // deepest node whose cached bounds contain it answers — never the
  // document's own position test, which a transform would break.
  assert.equal(hitTest(graph, { x: 320, y: 310 }, bounds)?.id, 'n2');
  assert.equal(hitTest(graph, { x: 10, y: 10 }, bounds)?.id, 'n0');

  // A hidden node never answers.
  assert.equal(
    hitTest(graph, { x: 10, y: 10 }, bounds, new Set(['n0'])),
    undefined,
  );
});

test('a click on empty space resolves to the nearest node', () => {
  const graph = mount(
    '<main><h1 id="t">T</h1><button id="pay">P</button></main>',
  );

  const bounds = boundsOf({
    n0: { x: 0, y: 0, width: 100, height: 40 },
    n1: { x: 200, y: 0, width: 40, height: 40 },
    n2: { x: 300, y: 300, width: 40, height: 40 },
  });

  // The point that missed every element still keeps the nearest one, so a
  // comment never loses its anchor.
  assert.equal(nearestNode(graph, { x: 320, y: 310 }, bounds)?.id, 'n2');
  assert.equal(nearestNode(graph, { x: 220, y: 60 }, bounds)?.id, 'n1');

  // A hidden node is never the nearest either.
  assert.equal(
    nearestNode(graph, { x: 220, y: 60 }, bounds, new Set(['n1']))?.id,
    'n0',
  );
});

test('isolation hides the siblings and keeps the selected chain', () => {
  const graph = mount(
    '<main><section id="a"><h1>A</h1></section><section id="b"><h2>B</h2><p>BP</p></section></main>',
  );

  // n0 main, n1 section#a, n2 h1, n3 section#b, n4 h2, n5 p
  const hidden = isolateHiddenIds(graph, 'n4');

  assert.deepEqual([...hidden].sort(), ['n1', 'n2', 'n5']);
});

test('the content box wraps every node, for ajustar', () => {
  const graph = mount('<main><h1 id="t">T</h1></main>');

  const bounds = boundsOf({
    n0: { x: 8, y: 4, width: 400, height: 300 },
    n1: { x: 8, y: 4, width: 100, height: 40 },
  });

  assert.deepEqual(contentBounds(graph, bounds), {
    x: 8,
    y: 4,
    width: 400,
    height: 300,
  });
});
