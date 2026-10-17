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
  clipBounds,
  contentBounds,
  hitTest,
  isolateHiddenIds,
  nearestNode,
  nodeLabel,
  type SceneGraph,
  stampLabel,
  visualBounds,
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

test('an element with no box neither bounds the content nor answers a pointer', () => {
  // A `display: contents` wrapper generates no box: the browser measures it
  // as an empty rect at the window's corner, far from the content. Under it,
  // the harness's frame, the story's card and its title.
  const graph = mount('<div><main><section><h1>T</h1></section></main></div>');

  const bounds = boundsOf({
    n0: { x: -320, y: -120, width: 0, height: 0 },
    n1: { x: 0, y: 0, width: 720, height: 528 },
    n2: { x: 24, y: 24, width: 672, height: 480 },
    n3: { x: 40, y: 48, width: 640, height: 36 },
  });

  assert.deepEqual(contentBounds(graph, bounds), {
    x: 0,
    y: 0,
    width: 720,
    height: 528,
  });
  assert.deepEqual(visualBounds(graph, bounds), {
    x: 24,
    y: 24,
    width: 672,
    height: 480,
  });
  assert.equal(hitTest(graph, { x: -320, y: -120 }, bounds), undefined);
  assert.equal(nearestNode(graph, { x: -300, y: -100 }, bounds)?.id, 'n1');
});

test('a box counts only the part its clipping ancestors leave visible', () => {
  // A scroll area 480 tall over a column 700 tall.
  const area = {
    box: { x: 24, y: 24, width: 672, height: 480 },
    x: true,
    y: true,
  };

  assert.deepEqual(
    clipBounds({ x: 24, y: 24, width: 672, height: 700 }, [area]),
    { x: 24, y: 24, width: 672, height: 480 },
  );

  // Scrolled out entirely: it keeps its place and takes no room.
  assert.deepEqual(
    clipBounds({ x: 40, y: 600, width: 640, height: 40 }, [area]),
    { x: 40, y: 600, width: 0, height: 0 },
  );

  // An ancestor that hides only one axis clips only that one.
  assert.deepEqual(
    clipBounds({ x: 0, y: 0, width: 900, height: 900 }, [
      { ...area, y: false },
    ]),
    { x: 24, y: 0, width: 672, height: 900 },
  );

  // Nothing clips it: the box is its own.
  assert.deepEqual(clipBounds({ x: 1, y: 2, width: 3, height: 4 }, []), {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  });
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

test('centring frames the element, not the page wrapper around it', () => {
  // A page-wide `main` centring a card across the whole height: its box is
  // the page, so the view centres the card inside it.
  const graph = mount(
    '<main><div class="card"><h1>T</h1><p>x</p></div></main>',
  );

  const bounds = boundsOf({
    n0: { x: 0, y: 0, width: 600, height: 900 },
    n1: { x: 150, y: 350, width: 300, height: 200 },
    n2: { x: 170, y: 370, width: 260, height: 40 },
    n3: { x: 170, y: 420, width: 260, height: 20 },
  });

  assert.deepEqual(visualBounds(graph, bounds), {
    x: 150,
    y: 350,
    width: 300,
    height: 200,
  });

  // Nothing but the page measurable: the page is what is centred.
  const lone = mount('<main></main>');
  assert.deepEqual(
    visualBounds(
      lone,
      boundsOf({ n0: { x: 0, y: 0, width: 600, height: 900 } }),
    ),
    { x: 0, y: 0, width: 600, height: 900 },
  );
});
