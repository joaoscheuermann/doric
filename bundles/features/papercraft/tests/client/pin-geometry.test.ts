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

import { anchorOf } from '../../src/client/anchor.js';
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
  buildSceneGraph,
  type SceneGraph,
} from '../../src/client/surface/scene-graph.js';
import type { CommentAnchor } from '../../src/contracts/index.js';

/** One rendered revision, with synthetic geometry (happy-dom measures zero). */
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

  return {
    graph: buildSceneGraph(root),
    bounds: (node) => {
      const [x = 0, y = 0, width = 0, height = 0] = (
        node.element.getAttribute('data-box') ?? ''
      )
        .split(' ')
        .map(Number);

      return { x, y, width, height };
    },
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
    })[0]
    ?.element.textContent?.trim();
};

/** The anchor a click at the centre of the element with `text` records. */
const clickOn = (revision: Revision, text: string): CommentAnchor => {
  const node = revision.graph.nodes.find(
    (candidate) => candidate.element.textContent === text,
  );
  assert.ok(node !== undefined, `no element reads ${text}`);

  const box = revision.bounds(node);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  return anchorOf(
    node.element,
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
