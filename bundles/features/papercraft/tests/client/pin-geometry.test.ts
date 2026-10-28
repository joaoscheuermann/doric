// Where a comment's pin lands on a later revision (`pin-geometry.ts`): the
// agent edits the file, every stamped line moves, and each pin still lands on
// the element the reader clicked — never on whatever element now sits at the
// recorded line.

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

import { anchorOf, pseudoOf } from '../../src/client/anchor.js';
import {
  anchorIndexOf,
  anchorResolver,
  type ContentPoint,
  offsetIn,
  pinPointOf,
} from '../../src/client/surface/pin-geometry.js';
import {
  type Bounds,
  type BoundsOf,
  type PseudoBoundsOf,
  type SceneGraph,
  sceneGraphOf,
} from '../../src/client/surface/scene-graph.js';
import type { CommentAnchor } from '../../src/contracts/index.js';
import { sceneNodesOf } from './support/fake-frame.js';

/**
 * One rendered revision, as its frame's scene reaches the canvas, with
 * synthetic geometry (happy-dom measures zero).
 */
interface Revision {
  readonly graph: SceneGraph;
  readonly bounds: BoundsOf;
}

const FILE = 'hello-world.html';

/** An element stamped from `line`, laid out at `box` ("x y width height"). */
const el = (
  tag: string,
  attributes: string,
  line: number | undefined,
  box: string,
  text: string,
): string =>
  `<${tag} ${attributes}${
    line === undefined
      ? ''
      : ` data-papercraft-source="${FILE}:${String(line)}"`
  } data-box="${box}">${text}</${tag}>`;

const render = (markup: string): Revision => {
  const root = document.createElement('div');
  root.innerHTML = markup;

  const { nodes, elements } = sceneNodesOf(root);
  const boxes = new Map(
    nodes.map((node, index) => {
      const [x = 0, y = 0, width = 0, height = 0] = (
        elements[index]?.getAttribute('data-box') ?? ''
      )
        .split(' ')
        .map(Number);

      return [node.id, { x, y, width, height }] as const;
    }),
  );

  return {
    graph: sceneGraphOf(nodes),
    bounds: (node) => boxes.get(node.id) ?? { x: 0, y: 0, width: 0, height: 0 },
  };
};

// Revision 1: the three cells the reader comments on sit at lines 97–99.
const REVISION_1 = render(
  el('h1', '', 90, '0 0 400 40', 'Hello, world') +
    el('p', 'class="subtitle"', 91, '0 50 400 20', 'A first page') +
    el('div', 'class="cell"', 97, '0 100 200 30', 'Alpha') +
    el('div', 'class="cell"', 98, '0 140 200 30', 'Beta') +
    el('div', 'class="cell"', 99, '0 180 200 30', 'Gamma'),
);

// Revision 2: dark-theme CSS above pushed every line down; lines 97–99 now
// hold the heading and the paragraphs, the cells moved to 122–124.
const REVISION_2 = render(
  el('h1', '', 97, '0 0 400 40', 'Hello, world') +
    el('p', 'class="subtitle"', 98, '0 50 400 20', 'A first page') +
    el('p', 'class="note"', 99, '0 74 400 20', 'Now in dark') +
    el('div', 'class="cell"', 122, '0 104 200 30', 'Alpha') +
    el('div', 'class="cell"', 123, '0 144 200 30', 'Beta') +
    el('div', 'class="cell"', 124, '0 184 200 30', 'Gamma'),
);

/** The text of the element whose box holds the point (the smallest one). */
const landsOn = (
  revision: Revision,
  point: ContentPoint | undefined,
): string | undefined => {
  if (point === undefined) return undefined;

  const inside = (box: Bounds) =>
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height;

  return revision.graph.nodes
    .filter((node) => inside(revision.bounds(node)))
    .sort((a, b) => {
      const boxA = revision.bounds(a);
      const boxB = revision.bounds(b);

      return boxA.width * boxA.height - boxB.width * boxB.height;
    })[0]?.text;
};

/** The anchor a click at the centre of the element with `text` records. */
const clickOn = (revision: Revision, text: string): CommentAnchor => {
  const node = revision.graph.nodes.find(
    (candidate) => candidate.text === text,
  );
  assert.ok(node !== undefined, `no element reads ${text}`);

  const box = revision.bounds(node);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  return anchorOf(
    node,
    offsetIn(box, point),
    point,
    anchorIndexOf(revision.graph, node),
  );
};

const pinOn = (revision: Revision, anchor: CommentAnchor) =>
  landsOn(revision, pinPointOf(anchor, revision.graph, revision.bounds));

const CELLS = ['Alpha', 'Beta', 'Gamma'] as const;

test('pins on three cells stay on their own cells when the edited file moves every line', () => {
  const anchors = CELLS.map((text) => clickOn(REVISION_1, text));

  assert.deepEqual(
    anchors.map((anchor) => pinOn(REVISION_1, anchor)),
    CELLS,
  );
  assert.deepEqual(
    anchors.map((anchor) => pinOn(REVISION_2, anchor)),
    CELLS,
  );
});

test('a revision places each anchor once, however often its pins are laid again', () => {
  const anchors = CELLS.map((text) => clickOn(REVISION_1, text));
  let measured = 0;
  const counting: BoundsOf = (node) => {
    measured += 1;

    return REVISION_2.bounds(node);
  };
  const resolve = anchorResolver(REVISION_2.graph, counting);

  // The first laying places the pins as a direct reading would.
  const first = anchors.map((anchor) => resolve(anchor));
  assert.deepEqual(
    first.map((point) => landsOn(REVISION_2, point)),
    CELLS,
  );

  // A zoom lays the same pins again: nothing is measured a second time.
  const after = measured;
  assert.deepEqual(
    anchors.map((anchor) => resolve(anchor)),
    first,
  );
  assert.equal(measured, after);

  // A fallback stands in only for an anchor nothing places.
  assert.deepEqual(
    resolve({ form: 'point' } as CommentAnchor, { x: 1, y: 2 }),
    { x: 1, y: 2 },
  );
});

test('a cell whose text the agent rewrote keeps its pin by its place among the cells', () => {
  const anchors = CELLS.map((text) => clickOn(REVISION_1, text));
  const rewritten = render(
    el('h1', '', 97, '0 0 400 40', 'Hello, world') +
      el('div', 'class="cell"', 122, '0 104 200 30', 'One') +
      el('div', 'class="cell"', 123, '0 144 200 30', 'Two') +
      el('div', 'class="cell"', 124, '0 184 200 30', 'Three'),
  );

  assert.deepEqual(
    anchors.map((anchor) => pinOn(rewritten, anchor)),
    ['One', 'Two', 'Three'],
  );
});

test('an anchor that recorded only its clicked point lands on the cell under it', () => {
  // Written before anchors recorded their text and ordinal: the stamp, the
  // selector and the clicked content point inside Beta's box on revision 1.
  const legacy: CommentAnchor = {
    form: 'source',
    path: FILE,
    line: 98,
    selector: 'div.cell',
    label: 'div',
    x: 100,
    y: 150,
  };

  assert.equal(pinOn(REVISION_2, legacy), 'Beta');
});

test('a pin whose element no longer exists falls back to the point it recorded', () => {
  const anchor = clickOn(REVISION_1, 'Gamma');
  const regrouped = render(
    el('h1', '', 97, '0 0 400 40', 'Hello, world') +
      el('section', 'class="card"', 99, '0 100 400 120', 'Gamma'),
  );

  assert.deepEqual(pinPointOf(anchor, regrouped.graph, regrouped.bounds), {
    x: 100,
    y: 195,
  });
});

test('cells a component renders from one line keep their own pins', () => {
  const list = (texts: readonly string[], top: number) =>
    render(
      texts
        .map((text, index) =>
          el(
            'div',
            'class="cell"',
            12,
            `0 ${String(top + index * 40)} 200 30`,
            text,
          ),
        )
        .join(''),
    );
  const anchors = CELLS.map((text) => clickOn(list(CELLS, 0), text));

  assert.deepEqual(
    anchors.map((anchor) => pinOn(list(CELLS, 60), anchor)),
    CELLS,
  );
});

test('unstamped cells commented by selector do not collapse onto the first one', () => {
  const cells = (top: number) =>
    render(
      el('p', '', undefined, '0 0 400 20', 'Intro') +
        CELLS.map((text, index) =>
          el(
            'div',
            'class="cell"',
            undefined,
            `0 ${String(top + index * 40)} 200 30`,
            text,
          ),
        ).join(''),
    );
  const anchors = CELLS.map((text) => clickOn(cells(40), text));

  assert.ok(anchors.every((anchor) => anchor.form === 'selector'));
  assert.deepEqual(
    anchors.map((anchor) => pinOn(cells(80), anchor)),
    CELLS,
  );
});

/* Pseudo-element anchors ---------------------------------------------------- */

test('an anchor on a pseudo-element keeps its host and names the pseudo', () => {
  const { graph } = render(el('div', 'id="pay"', 42, '0 0 100 40', 'Pagar'));
  const element = graph.nodes[0];
  assert.ok(element);

  const offset = { x: 0.25, y: 0.75 };
  const point = { x: 25, y: 43 };
  const host = anchorOf(element, offset, point, 2);
  const pseudo = anchorOf(element, offset, point, 2, '::after');

  assert.equal(host.form, 'source');
  assert.equal(host.label, 'div');
  assert.equal('pseudo' in host, false);

  // Form, stamp, selector, text, index and point stay the host's.
  assert.deepEqual(pseudo, { ...host, label: 'div::after', pseudo: '::after' });
  assert.equal(pseudo.path, FILE);
  assert.equal(pseudo.line, 42);
  assert.equal(pseudo.selector, 'div#pay');
  assert.equal((pseudo as { readonly index?: unknown }).index, 2);
  assert.deepEqual((pseudo as { readonly offset?: unknown }).offset, offset);

  assert.equal(pseudoOf(pseudo), '::after');
  assert.equal(pseudoOf({ ...host, pseudo: '::before' }), '::before');
  assert.equal(pseudoOf(host), undefined);
  assert.equal(pseudoOf({ ...host, pseudo: '::marker' } as never), undefined);
});

/** A 100×40 host whose `::after` strip is 4px tall right below it. */
const STRIPPED = render(
  el('div', 'id="host"', undefined, '0 0 100 40', 'Host'),
);
const STRIP: PseudoBoundsOf = (_, pseudo) =>
  pseudo === '::after' ? { x: 0, y: 40, width: 100, height: 4 } : undefined;
const NO_STRIP: PseudoBoundsOf = () => undefined;

const ON_HOST: CommentAnchor = {
  form: 'selector',
  selector: 'div#host',
  label: 'div',
  offset: { x: 0.5, y: 0.5 },
};
const ON_STRIP: CommentAnchor = {
  ...ON_HOST,
  label: 'div::after',
  pseudo: '::after',
};

test('a pseudo-element anchor pins at its offset inside the pseudo box', () => {
  const { graph, bounds } = STRIPPED;

  assert.deepEqual(pinPointOf(ON_STRIP, graph, bounds, undefined, STRIP), {
    x: 50,
    y: 42,
  });
  assert.deepEqual(anchorResolver(graph, bounds, STRIP)(ON_STRIP), {
    x: 50,
    y: 42,
  });
});

test('a pseudo-element anchor whose pseudo draws no box pins inside its host', () => {
  const { graph, bounds } = STRIPPED;

  assert.deepEqual(pinPointOf(ON_STRIP, graph, bounds, undefined, NO_STRIP), {
    x: 50,
    y: 20,
  });
  assert.deepEqual(anchorResolver(graph, bounds, NO_STRIP)(ON_STRIP), {
    x: 50,
    y: 20,
  });
});

test('an anchor without a pseudo pins inside its host, whatever the pseudo boxes', () => {
  const { graph, bounds } = STRIPPED;

  for (const pseudoBounds of [undefined, STRIP]) {
    assert.deepEqual(
      pinPointOf(ON_HOST, graph, bounds, undefined, pseudoBounds),
      {
        x: 50,
        y: 20,
      },
    );
    assert.deepEqual(anchorResolver(graph, bounds, pseudoBounds)(ON_HOST), {
      x: 50,
      y: 20,
    });
  }
  assert.deepEqual(pinPointOf(ON_HOST, graph, bounds), { x: 50, y: 20 });
  assert.deepEqual(anchorResolver(graph, bounds)(ON_HOST), { x: 50, y: 20 });
});
