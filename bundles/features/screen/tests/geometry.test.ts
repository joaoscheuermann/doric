// The panel geometry as a pure function of its arguments.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampGeometry,
  defaultGeometry,
  SCREEN_PANEL_INSET,
  SCREEN_PANEL_MIN_HEIGHT,
  SCREEN_PANEL_MIN_WIDTH,
} from '../src/client/domain/geometry.js';

test('a geometry inside the overlay is kept as it is', () => {
  assert.deepEqual(
    clampGeometry(
      { x: 10, y: 20, width: 300, height: 200 },
      { width: 800, height: 600 },
    ),
    { x: 10, y: 20, width: 300, height: 200 },
  );
});

test('a geometry is pulled back inside the overlay', () => {
  assert.deepEqual(
    clampGeometry(
      { x: 900, y: 700, width: 400, height: 300 },
      { width: 800, height: 600 },
    ),
    { x: 400, y: 300, width: 400, height: 300 },
  );
  assert.deepEqual(
    clampGeometry(
      { x: -50, y: -50, width: 400, height: 300 },
      { width: 800, height: 600 },
    ),
    { x: 0, y: 0, width: 400, height: 300 },
  );
});

test('a geometry never goes below its floor', () => {
  const clamped = clampGeometry(
    { x: 0, y: 0, width: 10, height: 10 },
    { width: 800, height: 600 },
  );

  assert.equal(clamped.width, SCREEN_PANEL_MIN_WIDTH);
  assert.equal(clamped.height, SCREEN_PANEL_MIN_HEIGHT);
});

test('a tiny overlay still answers the floor size', () => {
  const clamped = clampGeometry(
    { x: 0, y: 0, width: 10, height: 10 },
    { width: 100, height: 100 },
  );

  assert.equal(clamped.width, SCREEN_PANEL_MIN_WIDTH);
  assert.equal(clamped.height, SCREEN_PANEL_MIN_HEIGHT);
});

test('the default geometry sits in the overlay bottom-right corner', () => {
  const geometry = defaultGeometry({ width: 1200, height: 800 });

  assert.equal(geometry.x, 1200 - 640 - SCREEN_PANEL_INSET);
  assert.equal(geometry.y, 800 - 400 - SCREEN_PANEL_INSET);
  assert.equal(geometry.width, 640);
  assert.equal(geometry.height, 400);
});
