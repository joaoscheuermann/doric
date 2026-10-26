// The border box of an out-of-flow `::before`/`::after` (`pseudoBoxOf`,
// `scene-graph.ts`): derived from its computed insets and margins against
// the padding box of its containing block, so the outlines can cover a
// pseudo-element drawn outside its host.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Bounds,
  pseudoBoxOf,
  type PseudoStyle,
} from '../../src/client/surface/scene-graph.js';

const pseudo = (overrides: Partial<PseudoStyle> = {}): PseudoStyle => ({
  content: '""',
  position: 'absolute',
  left: '90px',
  top: '-6px',
  right: '-14px',
  bottom: '30px',
  marginLeft: '0px',
  marginTop: '0px',
  marginRight: '0px',
  marginBottom: '0px',
  ...overrides,
});

const block: Bounds = { x: 0, y: 0, width: 100, height: 40 };

test('an absolute pseudo-element is placed by its insets in its containing block', () => {
  assert.deepEqual(pseudoBoxOf(pseudo(), block, 1), {
    x: 90,
    y: -6,
    width: 24,
    height: 16,
  });
});

test('the insets are scaled by the factor from an offset containing block', () => {
  assert.deepEqual(
    pseudoBoxOf(pseudo(), { x: 10, y: 10, width: 200, height: 80 }, 2),
    { x: 190, y: -2, width: 48, height: 32 },
  );
});

test('the margins shift the border box inside its insets', () => {
  assert.deepEqual(
    pseudoBoxOf(pseudo({ marginLeft: '4px', marginTop: '2px' }), block, 1),
    { x: 94, y: -4, width: 20, height: 14 },
  );
});

test('a pseudo-element that generates no box, or stays in flow, has no box of its own', () => {
  assert.equal(pseudoBoxOf(pseudo({ content: 'none' }), block, 1), undefined);
  assert.equal(pseudoBoxOf(pseudo({ content: 'normal' }), block, 1), undefined);
  assert.equal(
    pseudoBoxOf(pseudo({ position: 'static' }), block, 1),
    undefined,
  );
  assert.equal(
    pseudoBoxOf(pseudo({ position: 'relative' }), block, 1),
    undefined,
  );
  assert.equal(pseudoBoxOf(pseudo({ left: 'auto' }), block, 1), undefined);
});

test('a fixed pseudo-element is placed the same way in the block it is given', () => {
  assert.deepEqual(pseudoBoxOf(pseudo({ position: 'fixed' }), block, 1), {
    x: 90,
    y: -6,
    width: 24,
    height: 16,
  });
});
