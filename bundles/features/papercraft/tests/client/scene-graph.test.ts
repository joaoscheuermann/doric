// The derived tree (`scene-graph.ts`): built from the nodes the preview's
// frame serialized from the DOM the revision rendered (untrusted: checked as
// it is read), stamps inherited down, and every pointer question answered
// from the frame's bounds — hit-testing under pan/zoom without
// `document.elementFromPoint`, the nearest node for a click on empty space,
// isolation and the content box.

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

import type { SceneNodeData } from '../../src/client/frame-protocol.js';
import { hoverLabelOf } from '../../src/client/surface/overlays.js';
import {
  type Bounds,
  clipBounds,
  contentBounds,
  hitTest,
  isolateHiddenIds,
  nearestNode,
  nodeLabel,
  type PseudoBoundsOf,
  type SceneGraph,
  sceneGraphOf,
  stampLabel,
  targetBounds,
  targetById,
  targetIdOf,
  targetLabel,
  visualBounds,
} from '../../src/client/surface/scene-graph.js';
import { sceneNodesOf } from './support/fake-frame.js';

/** The tree of what a frame rendering `markup` would send. */
const mount = (markup: string): SceneGraph => {
  const root = document.createElement('div');
  root.innerHTML = markup;

  return sceneGraphOf(sceneNodesOf(root).nodes);
};

const node = (
  id: string,
  extra: Partial<SceneNodeData> = {},
): SceneNodeData => ({
  id,
  depth: 0,
  tag: 'div',
  classes: [],
  text: '',
  bounds: { x: 0, y: 0, width: 0, height: 0 },
  ...extra,
});

test('the tree is the frame nodes in document order, parents before children', () => {
  const graph = mount('<main><h1 id="t">T</h1><p class="a b">x</p></main>');

  assert.deepEqual(
    graph.nodes.map((each) => each.tag),
    ['main', 'h1', 'p'],
  );
  assert.equal(graph.nodes[0]?.parentId, undefined);
  assert.equal(graph.nodes[1]?.parentId, 'n0');
  assert.equal(graph.nodes[2]?.depth, 1);
  assert.deepEqual(graph.nodes[2]?.classes, ['a', 'b']);
  assert.equal(graph.childrenOf.get('n0')?.length, 2);
});

test('the tree trusts only what it can check of the frame nodes', () => {
  const graph = sceneGraphOf([
    node('n0', { tag: 'MAIN', depth: 7 }),
    // A repeated id is the first node's: the second is dropped.
    node('n0', { tag: 'aside' }),
    node('n1', { parentId: 'n0', depth: 0 }),
    // A parent that never came first leaves the node at the root.
    node('n2', { parentId: 'n9', depth: 3 }),
    node('n3', { parentId: 'n2' }),
  ]);

  assert.deepEqual(
    graph.nodes.map((each) => [each.id, each.tag, each.depth, each.parentId]),
    [
      ['n0', 'main', 0, undefined],
      ['n1', 'div', 1, 'n0'],
      ['n2', 'div', 0, undefined],
      ['n3', 'div', 1, 'n2'],
    ],
  );
  assert.deepEqual(
    graph.childrenOf.get(undefined)?.map((each) => each.id),
    ['n0', 'n2'],
  );
});

test('the origin stamp walks down from the stamped ancestor', () => {
  const graph = mount(
    '<main data-papercraft-source="src/Checkout.tsx:42"><section><button id="pay">Pagar</button></section></main>',
  );

  const main = graph.nodes[0];
  const button = graph.nodes[2];

  assert.deepEqual(main?.stamp, { path: 'src/Checkout.tsx', line: 42 });
  assert.deepEqual(button?.stamp, { path: 'src/Checkout.tsx', line: 42 });
  assert.equal(stampLabel(button as never), 'src/Checkout.tsx:42');
  assert.equal(nodeLabel(button as never), 'button#pay');
  // Only the stamped element carries the stamp as its own.
  assert.equal(main?.source, 'src/Checkout.tsx:42');
  assert.equal(button?.source, undefined);
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

test('a target id names a node, or one of its ::before / ::after, and round-trips', () => {
  const graph = mount('<main><h1 id="t">T</h1></main>');
  const h1 = graph.byId.get('n1');

  const pseudo = targetById(graph, 'n1::before');
  assert.equal(pseudo?.node.id, 'n1');
  assert.equal(pseudo?.pseudo, '::before');

  const plain = targetById(graph, 'n1');
  assert.equal(plain?.node.id, 'n1');
  assert.equal(plain !== undefined && 'pseudo' in plain, false);

  assert.equal(targetById(graph, 'n1::marker'), undefined);
  assert.equal(targetById(graph, 'n1::'), undefined);
  assert.equal(targetById(graph, 'n99::after'), undefined);
  assert.equal(targetById(graph, 'nope'), undefined);

  assert.ok(h1);
  assert.equal(targetIdOf({ node: h1 }), 'n1');
  assert.equal(targetIdOf({ node: h1, pseudo: '::after' }), 'n1::after');

  for (const target of [
    { node: h1 },
    { node: h1, pseudo: '::after' as const },
  ]) {
    const back = targetById(graph, targetIdOf(target));

    assert.equal(back?.node.id, target.node.id);
    assert.equal(back?.pseudo, target.pseudo);
  }
});

test('a pseudo target is framed by its own box, else by its host', () => {
  const graph = mount('<main></main>');
  const main = graph.byId.get('n0');
  assert.ok(main);

  const host = { x: 0, y: 0, width: 100, height: 40 };
  const strip = { x: 0, y: 40, width: 100, height: 4 };
  const bounds = boundsOf({ n0: host });
  const drawn: PseudoBoundsOf = (_, pseudo) =>
    pseudo === '::after' ? strip : undefined;

  assert.deepEqual(
    targetBounds({ node: main, pseudo: '::after' }, bounds, drawn),
    strip,
  );
  assert.deepEqual(targetBounds({ node: main }, bounds, drawn), host);
  // A pseudo that draws no box, or no pseudo measure at all: the host.
  assert.deepEqual(
    targetBounds({ node: main, pseudo: '::before' }, bounds, drawn),
    host,
  );
  assert.deepEqual(
    targetBounds({ node: main, pseudo: '::after' }, bounds),
    host,
  );
});

test('the hover label names the pseudo-element after its host, then the source line', () => {
  const graph = mount(
    '<div class="font-conversation" data-papercraft-source="src/editor.tsx:400"></div>',
  );
  const div = graph.byId.get('n0');
  assert.ok(div);

  assert.equal(
    targetLabel({ node: div, pseudo: '::before' }),
    'div.font-conversation::before',
  );
  assert.equal(targetLabel({ node: div }), 'div.font-conversation');
  assert.equal(
    hoverLabelOf({ node: div, pseudo: '::before' }),
    'div.font-conversation::before · editor.tsx:400',
  );
  assert.equal(
    hoverLabelOf({ node: div }),
    'div.font-conversation · editor.tsx:400',
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
