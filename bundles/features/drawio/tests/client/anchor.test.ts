// What the client reads of a revision's `mxfile` (model.ts) and the anchor of
// a diagram comment (anchor.ts): its selectors, the hit-test that builds it on
// the page on screen and the re-anchoring that places a stored anchor on a
// revision's page (spec "Âncora").
//
// Contract matrix (plan §4, anchor.test rows 1–15):
// - model: pages in order with id and name ('' when absent); only vertex and
//   edge cells, in document order, with their kind and label; labels from
//   `<object>`/`<UserObject>` `label` or the `mxCell` `value`, HTML reduced to
//   text, entities decoded, whitespace collapsed, at most 200 characters; an
//   `mxfile` it cannot read is `RenderError('invalid-xml')`;
// - selectors: built with the ids verbatim and the point rounded; read back;
//   a cell id runs to the end; anything else reads as undefined;
// - hit-test: the smallest box under the pointer, ties to the last, never a
//   layer, edges included, the same in both modes; a cell anchor with the
//   box centre and its index among same-kind, same-label cells; a free point
//   with the nearest centre's label;
// - placement: rule 1 (same id and kind, `changed` on a new label), rule 2
//   (same kind and label, by index, else nearest), rule 3 (a loose pin at
//   the anchor's point), a free point, the unleased lookup by id, and
//   undefined for an anchor on any page but the one on screen (Q1).

import './support/dom.js';

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import {
  cellSelectorOf,
  type DiagramView,
  diagramAnchorOf,
  diagramHitTester,
  parseDiagramSelector,
  placeAnchor,
  pointSelectorOf,
} from '../../src/client/anchor.js';
import {
  type DiagramPage,
  diagramModelOf,
  labelTextOf,
} from '../../src/client/model.js';
import { RenderError } from '../../src/client/renderer.js';
import type {
  DiagramAnchor,
  DiagramCellAnchor,
  DiagramLayout,
  DiagramPointAnchor,
} from '../../src/contracts/index.js';
import { closeDom } from './support/dom.js';

after(closeDom);

const isInvalidXml = (error: unknown): boolean =>
  error instanceof RenderError && error.code === 'invalid-xml';

const LONG = 'x'.repeat(250);

/** Two pages: wrapped and plain labels, HTML, entities, an edge, the layers. */
const TWO_PAGES = `<mxfile host="test">
  <diagram id="p1" name="One">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <object id="o1" label="&lt;b&gt;Tom&lt;/b&gt; &amp;amp; Jerry">
          <mxCell style="rounded=1;" vertex="1" parent="1">
            <mxGeometry x="0" y="0" width="80" height="40" as="geometry"/>
          </mxCell>
        </object>
        <mxCell id="v1" value="a&lt;br&gt;b" style="html=1;" vertex="1" parent="1">
          <mxGeometry x="100" y="0" width="80" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="v2" value="  many   spaces  " vertex="1" parent="1">
          <mxGeometry x="200" y="0" width="80" height="40" as="geometry"/>
        </mxCell>
        <mxCell id="e1" edge="1" source="o1" target="v1" parent="1">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="long" value="${LONG}" vertex="1" parent="1">
          <mxGeometry x="300" y="0" width="80" height="40" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
  <diagram id="p2">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <UserObject id="u1" label="Plain &amp; simple">
          <mxCell vertex="1" parent="1">
            <mxGeometry x="0" y="0" width="80" height="40" as="geometry"/>
          </mxCell>
        </UserObject>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

const box = (id: string, x: number, y: number, width: number, height: number) =>
  ({ id, x, y, width, height }) as const;

const layoutOf = (
  cells: DiagramLayout['cells'],
  width = 1000,
  height = 1000,
): DiagramLayout => ({ width, height, cells });

const at = (x: number, y: number) => ({ content: { x, y } });

const cellAnchor = (
  pageId: string,
  cellId: string,
  label: string,
  cellKind: DiagramCellAnchor['cellKind'],
  index: number,
  x: number,
  y: number,
): DiagramCellAnchor => ({
  form: 'selector',
  selector: `page/${pageId}/cell/${cellId}`,
  label,
  x,
  y,
  cellKind,
  index,
});

const pointAnchor = (
  pageId: string,
  x: number,
  y: number,
  label = '',
): DiagramPointAnchor => ({
  form: 'selector',
  selector: `page/${pageId}/point/${Math.round(x)},${Math.round(y)}`,
  label,
  x,
  y,
});

describe('model', () => {
  test('reads the pages, their vertex and edge cells, kinds and text labels (row 1)', () => {
    const model = diagramModelOf(TWO_PAGES);

    assert.deepEqual(model.pages, [
      {
        id: 'p1',
        name: 'One',
        cells: [
          { id: 'o1', kind: 'vertex', label: 'Tom & Jerry' },
          { id: 'v1', kind: 'vertex', label: 'a b' },
          { id: 'v2', kind: 'vertex', label: 'many spaces' },
          { id: 'e1', kind: 'edge', label: '' },
          { id: 'long', kind: 'vertex', label: 'x'.repeat(200) },
        ],
      },
      {
        id: 'p2',
        name: '',
        cells: [{ id: 'u1', kind: 'vertex', label: 'Plain & simple' }],
      },
    ]);
    assert.equal(model.cellCount, 6);
    assert.equal(labelTextOf('<div>one</div><div>two</div>'), 'one two');
    assert.equal(labelTextOf('x &lt; y &amp; z'), 'x < y & z');
    assert.equal(labelTextOf(''), '');
  });

  test('an mxfile it cannot read is invalid-xml (row 2)', () => {
    assert.throws(() => diagramModelOf('<mxfile><diagram'), isInvalidXml);
    assert.throws(() => diagramModelOf('<root/>'), isInvalidXml);
    assert.throws(
      () => diagramModelOf('<mxfile><diagram id="p"/></mxfile>'),
      isInvalidXml,
    );
  });
});

describe('selectors', () => {
  test('builds, reads back and refuses selectors (row 3)', () => {
    assert.equal(cellSelectorOf('p1', 'a'), 'page/p1/cell/a');
    assert.equal(pointSelectorOf('p1', 10.4, 20.5), 'page/p1/point/10,21');

    assert.deepEqual(parseDiagramSelector('page/p1/cell/a'), {
      pageId: 'p1',
      cellId: 'a',
    });
    assert.deepEqual(parseDiagramSelector('page/p1/point/10,21'), {
      pageId: 'p1',
      point: { x: 10, y: 21 },
    });
    assert.deepEqual(parseDiagramSelector('page/p1/point/-3,4'), {
      pageId: 'p1',
      point: { x: -3, y: 4 },
    });
    assert.deepEqual(parseDiagramSelector('page/p1/cell/a/b'), {
      pageId: 'p1',
      cellId: 'a/b',
    });

    for (const garbage of [
      '',
      'page/p1',
      'page//cell/a',
      'page/p1/cell/',
      'page/p1/point/1.5,2',
      'page/p1/point/1',
      'page/p1/point/1,2/x',
      'page/p1/frame/a',
      'doc/p1/cell/a',
    ]) {
      assert.equal(parseDiagramSelector(garbage), undefined, garbage);
    }
  });
});

describe('hit-test', () => {
  const page: DiagramPage = {
    id: 'p1',
    name: 'One',
    cells: [
      { id: 'big', kind: 'vertex', label: 'Big' },
      { id: 'small', kind: 'vertex', label: 'Small' },
      { id: 'twinA', kind: 'vertex', label: 'T' },
      { id: 'twinB', kind: 'vertex', label: 'T' },
      { id: 'conn', kind: 'edge', label: '' },
    ],
  };
  const layout = layoutOf([
    box('1', 0, 0, 1000, 1000),
    box('big', 0, 0, 100, 100),
    box('small', 10, 10, 20, 20),
    box('twinA', 200, 0, 10, 10),
    box('twinB', 200, 0, 10, 10),
    box('conn', 300, 0, 50, 4),
  ]);

  test('targets the smallest box, the last on a tie, never a layer, in both modes (row 4)', () => {
    const tester = diagramHitTester({ pageId: 'p1', page, layout });

    for (const mode of ['select', 'point'] as const) {
      assert.equal(tester.targetAt(at(15, 15), mode), 'small', mode);
      assert.equal(tester.targetAt(at(50, 50), mode), 'big', mode);
      assert.equal(tester.targetAt(at(205, 5), mode), 'twinB', mode);
      assert.equal(tester.targetAt(at(320, 2), mode), 'conn', mode);
      assert.equal(tester.targetAt(at(500, 500), mode), undefined, mode);
      assert.equal(tester.targetAt(at(-5, -5), mode), undefined, mode);
    }

    const unread = diagramHitTester({ pageId: 'p1', layout });

    assert.equal(unread.targetAt(at(15, 15), 'select'), undefined);
  });

  const labelled: DiagramPage = {
    id: 'p1',
    name: 'One',
    cells: [
      { id: 'a', kind: 'vertex', label: 'A' },
      { id: 'b', kind: 'vertex', label: 'A' },
      { id: 'e', kind: 'edge', label: 'go' },
      { id: 'f', kind: 'edge', label: 'go' },
    ],
  };
  const labelledLayout = layoutOf([
    box('a', 0, 0, 40, 20),
    box('b', 100, 50, 40, 20),
    box('e', 50, 10, 50, 2),
    box('f', 50, 60, 50, 2),
  ]);

  test('anchors on a target: its box centre, label, kind and index (row 5)', () => {
    const tester = diagramHitTester({
      pageId: 'p1',
      page: labelled,
      layout: labelledLayout,
    });

    assert.deepEqual(
      tester.anchorAt(at(110, 55), 'b'),
      cellAnchor('p1', 'b', 'A', 'vertex', 1, 120, 60),
    );
    assert.deepEqual(
      tester.anchorAt(at(60, 61), 'f'),
      cellAnchor('p1', 'f', 'go', 'edge', 1, 75, 61),
    );
    assert.deepEqual(
      tester.anchorAt(at(5, 5), 'a'),
      cellAnchor('p1', 'a', 'A', 'vertex', 0, 20, 10),
    );
  });

  test('anchors off a target on a free point with the nearest label (row 6)', () => {
    const tester = diagramHitTester({
      pageId: 'p1',
      page: labelled,
      layout: labelledLayout,
    });

    assert.deepEqual(
      tester.anchorAt(at(12.4, 20.6), undefined),
      pointAnchor('p1', 12.4, 20.6, 'A'),
    );
    assert.deepEqual(
      tester.anchorAt(at(80, 64), 'nope'),
      pointAnchor('p1', 80, 64, 'go'),
    );

    const empty = diagramHitTester({
      pageId: 'p1',
      page: { id: 'p1', name: '', cells: [] },
      layout: layoutOf([box('1', 0, 0, 1000, 1000)]),
    });

    assert.deepEqual(
      empty.anchorAt(at(3, 4), undefined),
      pointAnchor('p1', 3, 4, ''),
    );
  });
});

describe('placement', () => {
  const page: DiagramPage = {
    id: 'p1',
    name: 'One',
    cells: [
      { id: 'a', kind: 'vertex', label: 'A' },
      { id: 'b', kind: 'vertex', label: 'B' },
      { id: 'x1', kind: 'vertex', label: 'X' },
      { id: 'x2', kind: 'vertex', label: 'X' },
      { id: 'e1', kind: 'edge', label: 'link' },
    ],
  };
  const layout = layoutOf([
    box('1', 0, 0, 1000, 1000),
    box('a', 0, 0, 40, 20),
    box('b', 100, 0, 40, 20),
    box('x1', 0, 100, 20, 20),
    box('x2', 200, 100, 20, 20),
    box('e1', 50, 50, 100, 2),
  ]);
  const view: DiagramView = {
    pageId: 'p1',
    pageIds: ['p1', 'p2'],
    page,
    layout,
  };

  const place = (anchor: DiagramAnchor, on: DiagramView = view) => {
    const placement = placeAnchor(anchor, on);

    assert.ok(placement !== undefined, 'a placement');

    return placement;
  };

  test('rule 1: the same id, kind and label sits on the box centre, unchanged (row 7)', () => {
    const placement = place(cellAnchor('p1', 'a', 'A', 'vertex', 0, 1, 1));

    assert.deepEqual(placement.point, { x: 20, y: 10 });
    assert.equal(placement.cellId, 'a');
    assert.ok(!placement.changed);
  });

  test('rule 1 with another label is a changed cell (row 8)', () => {
    const placement = place(cellAnchor('p1', 'a', 'Old', 'vertex', 0, 1, 1));

    assert.deepEqual(placement.point, { x: 20, y: 10 });
    assert.equal(placement.cellId, 'a');
    assert.equal(placement.changed, true);
  });

  test('the same id of another kind falls through to rule 2 (row 9)', () => {
    const placement = place(cellAnchor('p1', 'a', 'link', 'edge', 0, 1, 1));

    assert.deepEqual(placement.point, { x: 100, y: 51 });
    assert.equal(placement.cellId, 'e1');
    assert.ok(!placement.changed);
  });

  test('rule 2: the same kind and label, by index, else the nearest centre (row 10)', () => {
    const byIndex = place(cellAnchor('p1', 'gone', 'X', 'vertex', 1, 0, 0));

    assert.deepEqual(byIndex.point, { x: 210, y: 110 });
    assert.equal(byIndex.cellId, 'x2');

    const nearFirst = place(
      cellAnchor('p1', 'gone', 'X', 'vertex', 5, 15, 105),
    );

    assert.deepEqual(nearFirst.point, { x: 10, y: 110 });
    assert.equal(nearFirst.cellId, 'x1');

    const nearSecond = place(
      cellAnchor('p1', 'gone', 'X', 'vertex', 5, 205, 100),
    );

    assert.deepEqual(nearSecond.point, { x: 210, y: 110 });
    assert.equal(nearSecond.cellId, 'x2');
  });

  test('rule 3: no candidate leaves a loose pin at the anchor point (row 11)', () => {
    const placement = place(
      cellAnchor('p1', 'gone', 'Nothing', 'vertex', 0, 333, 444),
    );

    assert.deepEqual(placement.point, { x: 333, y: 444 });
    assert.equal(placement.cellId, undefined);
  });

  test('an anchor on a page the revision lacks is detached (row 12)', () => {
    assert.equal(
      placeAnchor(cellAnchor('p9', 'a', 'A', 'vertex', 0, 1, 1), view),
      undefined,
    );
  });

  test('a free point sits at its point on its page, detached elsewhere (row 13)', () => {
    const placement = place(pointAnchor('p1', 12.5, 7.25));

    assert.deepEqual(placement.point, { x: 12.5, y: 7.25 });
    assert.equal(placement.cellId, undefined);
    assert.equal(placeAnchor(pointAnchor('p9', 12.5, 7.25), view), undefined);
  });

  test('unleased (no page model): the box of the anchor id, else its point (row 14)', () => {
    const unleased: DiagramView = { pageId: 'p1', layout };
    const onBox = place(
      cellAnchor('p1', 'a', 'Old', 'vertex', 0, 1, 1),
      unleased,
    );

    assert.deepEqual(onBox.point, { x: 20, y: 10 });
    assert.equal(onBox.cellId, 'a');
    assert.ok(!onBox.changed);

    const loose = place(
      cellAnchor('p1', 'gone', 'A', 'vertex', 0, 333, 444),
      unleased,
    );

    assert.deepEqual(loose.point, { x: 333, y: 444 });
    assert.equal(loose.cellId, undefined);
  });

  test('an anchor on another existing page of the revision is detached (row 15, Q1)', () => {
    assert.equal(
      placeAnchor(cellAnchor('p2', 'a', 'A', 'vertex', 0, 1, 1), view),
      undefined,
    );
    assert.equal(placeAnchor(pointAnchor('p2', 5, 5), view), undefined);
  });
});

describe('diagramAnchorOf', () => {
  test('reads a cell or point anchor, drops extra keys, refuses garbage', () => {
    const base = { form: 'selector', label: 'L', x: 1, y: 2 } as const;
    const cell = {
      ...base,
      selector: 'page/p1/cell/c1',
      cellKind: 'vertex',
      index: 0,
    };
    const point = { ...base, selector: pointSelectorOf('p1', 1, 2) };

    assert.deepEqual(diagramAnchorOf({ ...cell, extra: 1 }), cell);
    assert.deepEqual(diagramAnchorOf({ ...point, extra: 1 }), point);
    for (const garbage of [
      null,
      'x',
      1,
      {},
      { ...point, x: 'a' },
      { ...cell, index: -1 },
      { ...point, cellKind: 'vertex' },
    ]) {
      assert.equal(diagramAnchorOf(garbage), undefined);
    }
  });
});
