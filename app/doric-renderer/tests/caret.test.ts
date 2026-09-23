import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { caretAtLineEdgeOfBoxes, type RenderedBox } from '../src/chat/caret';

/** A rendered box, with `bottom` derived the way the browser reports it. */
const box = (top: number, height: number, width = 1): RenderedBox => ({
  top,
  bottom: top + height,
  height,
  width,
});

/** The editor root: one line of text is 20px tall inside a 100px container. */
const root = box(0, 100);
const line = (top: number): RenderedBox => box(top, 20);

/** What a collapsed range in an empty paragraph measures: a rect at the origin. */
const empty = box(0, 0, 0);

describe('caret line edge', () => {
  test('reads a caret within half a line of the root top as the first line', () => {
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', line(8), undefined, root),
      true,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', line(11), undefined, root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', line(8), undefined, root),
      false,
    );
  });

  test('reads a caret within half a line of the root bottom as the last line', () => {
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', line(72), undefined, root),
      true,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', line(69), undefined, root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', line(72), undefined, root),
      false,
    );
  });

  test('floors the slack at one pixel for a caret shorter than two', () => {
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', box(1, 1), undefined, root),
      true,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', box(2, 1), undefined, root),
      false,
    );
  });

  test('reads the edge from the block box when the caret rect is empty', () => {
    // The empty caret rect sits at the origin for every block, so the block box
    // — first, middle, then last — is what decides the edge.
    assert.equal(caretAtLineEdgeOfBoxes('ArrowUp', empty, line(8), root), true);
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', empty, line(8), root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', empty, line(40), root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', empty, line(40), root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', empty, line(72), root),
      true,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', empty, line(72), root),
      false,
    );
  });

  test('reads no edge for an empty caret rect without a block box', () => {
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', empty, undefined, root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowDown', empty, undefined, root),
      false,
    );
  });

  test('measures a caret rect that is only flat or only hairline', () => {
    // The block box would answer "first line" for both of these.
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', box(40, 0, 4), line(8), root),
      false,
    );
    assert.equal(
      caretAtLineEdgeOfBoxes('ArrowUp', box(40, 20, 0), line(8), root),
      false,
    );
  });
});
