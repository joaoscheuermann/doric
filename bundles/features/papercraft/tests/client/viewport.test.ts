// The viewport math (`surface/viewport.ts`): pan and zoom are one transform,
// every zoom keeps the pointer stable, ajustar fits the content and the
// reading is whole percents. All of it is pure and view-local — replay never
// drags the reader anywhere.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fitViewport,
  GRID_MAJOR_EVERY,
  GRID_STEP,
  gridBackground,
  IDENTITY,
  toContent,
  type Viewport,
  viewportTransform,
  zoomAt,
  zoomPercent,
} from '../../src/client/surface/viewport.js';

test('identity reads 100% and transforms to nothing', () => {
  assert.equal(zoomPercent(IDENTITY), '100%');
  assert.equal(viewportTransform(IDENTITY), 'translate(0px, 0px) scale(1)');
});

test('zooming keeps the pointer stable', () => {
  const viewport: Viewport = { scale: 1, tx: 40, ty: 20 };
  const origin = { x: 100, y: 60 };
  const zoomed = zoomAt(viewport, 2, origin);

  // What was at (100, 60) before is still there: content point (60, 40).
  assert.equal(zoomed.tx + 60 * zoomed.scale, origin.x);
  assert.equal(zoomed.ty + 40 * zoomed.scale, origin.y);
  assert.equal(zoomPercent(zoomed), '200%');
});

test('zoom is clamped, both ways', () => {
  assert.equal(zoomAt(IDENTITY, 100).scale, 4);
  assert.equal(zoomAt(IDENTITY, 0.01).scale, 0.25);
});

test('ajustar fits the content into the area, centred, clamped', () => {
  const fitted = fitViewport(
    { x: 100, y: 50, width: 800, height: 600 },
    { width: 400, height: 300 },
    24,
  );

  assert.equal(fitted.scale, 0.42);
  // Centred: the content's box sits with equal margins on the x axis.
  assert.ok(Math.abs(fitted.tx + 100 * fitted.scale - 32) < 1e-9);

  // A tiny artifact would blow up: ajustar is a fit, not a magnifier, so it
  // never goes above identity.
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 10, height: 10 },
      { width: 400, height: 300 },
    ).scale,
    1,
  );

  // A huge artifact still stops at the lower limit every zoom has.
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 100_000, height: 100_000 },
      { width: 400, height: 300 },
    ).scale,
    0.25,
  );

  // Nothing to fit into: identity.
  assert.equal(
    fitViewport(
      { x: 0, y: 0, width: 800, height: 600 },
      { width: 0, height: 0 },
    ).scale,
    1,
  );
});

test('a surface point becomes the content point under any pan/zoom', () => {
  const viewport: Viewport = { scale: 2, tx: 100, ty: -40 };

  assert.deepEqual(toContent(viewport, { x: 300, y: 60 }), { x: 100, y: 50 });
  assert.deepEqual(toContent(IDENTITY, { x: 5, y: 6 }), { x: 5, y: 6 });
});

test('the dot grid marks the crossings and rides the viewport', () => {
  const layers = (value: string) => value.split(/,\s*/);
  const images = (value: string) => value.match(/radial-gradient\(/g)?.length;

  // At identity a major dot every four steps and a minor dot every step,
  // each tile centred on the crossing at content (0, 0).
  const still = gridBackground(IDENTITY);
  const major = GRID_STEP * GRID_MAJOR_EVERY;
  assert.equal(images(still.backgroundImage), 2);
  assert.deepEqual(layers(still.backgroundSize), [
    `${major}px ${major}px`,
    `${GRID_STEP}px ${GRID_STEP}px`,
  ]);
  assert.deepEqual(layers(still.backgroundPosition), [
    `${-major / 2}px ${-major / 2}px`,
    `${-GRID_STEP / 2}px ${-GRID_STEP / 2}px`,
  ]);

  // Panned and zoomed, the crossings move and space out with the content.
  const moved = gridBackground({ scale: 2, tx: 30, ty: -10 });
  assert.equal(
    layers(moved.backgroundSize)[1],
    `${GRID_STEP * 2}px ${GRID_STEP * 2}px`,
  );
  assert.equal(
    layers(moved.backgroundPosition)[1],
    `${30 - GRID_STEP}px ${-10 - GRID_STEP}px`,
  );

  // Zoomed far out the minor dots would crowd into noise: only majors stay.
  const far = gridBackground({ scale: 0.25, tx: 0, ty: 0 });
  assert.equal(images(far.backgroundImage), 1);
});
